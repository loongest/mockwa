import type { Kysely } from "kysely";
import type { AppConfig } from "./config/index.ts";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type Database,
	type DatabaseHandle,
	type Repositories,
} from "./db/index.ts";
import {
	AccountEventService,
	AppService,
	applySeed,
	BusinessProfileService,
	combineOutboundMessageEvents,
	ContactService,
	ConversationService,
	PhoneService,
	createBackgroundTasks,
	createEventBus,
	createSystemScheduler,
	GraphRequestLog,
	InboundService,
	InjectionService,
	MediaService,
	MessageService,
	MessagingRules,
	ObjectService,
	PhoneNumberService,
	ReadReceiptService,
	ResetService,
	SnapshotService,
	StateService,
	StatusLadder,
	SubscribedAppService,
	TemplateLifecycle,
	TemplateService,
	TokenRegistry,
	TypingService,
	UploadService,
	WabaService,
	WebhookEmitter,
	createDepartedNumbers,
	ClockService,
	ScenarioRunner,
	createRandomIdStream,
	createSeededIdStream,
	VirtualClock,
	VisitorSessionService,
	type BackgroundTasks,
	type IdStream,
	type EventBus,
	type Scheduler,
	type SeedResult,
} from "./domain/index.ts";
import type { Logger } from "./logging/index.ts";
import type { Clock } from "./timestamps.ts";
import { createMediaStorage, type MediaStorage } from "./storage/index.ts";

export interface CreateServicesOptions {
	config: AppConfig;
	logger: Logger;
	/**
	 * Injected by tests that drive time. Defaults to real timers inside every service, or to a
	 * {@link VirtualClock} when `WASANDBOX_CLOCK=virtual`; a `VirtualClock` passed here is treated
	 * as the instance's virtual clock (SPEC §4, "Virtual clock").
	 */
	scheduler?: Scheduler;
}

/** The domain services the two API surfaces are built on (SPEC §8). */
export interface DomainServices {
	/** Graph API mock (SPEC §2). */
	objects: ObjectService;
	messages: MessageService;
	readReceipts: ReadReceiptService;
	media: MediaService;
	/** The Resumable Upload API and the handles it mints (SPEC §2.21). */
	uploads: UploadService;
	templates: TemplateService;
	/** Business profile and `subscribed_apps` (SPEC §2.19-§2.20). */
	businessProfiles: BusinessProfileService;
	subscribedApps: SubscribedAppService;
	/** The apps webhooks go to, their subscriptions and overrides (SPEC §3). */
	apps: AppService;
	/** Webhook engine, status ladder and template review (SPEC §3, §4). */
	webhooks: WebhookEmitter;
	statusLadder: StatusLadder;
	templateLifecycle: TemplateLifecycle;
	/** The account-level webhooks the UI and control plane can emit (SPEC §3). */
	accountEvents: AccountEventService;
	/** Typing indicators: in-memory, announced over the WebSocket (SPEC §2.18). */
	typing: TypingService;
	/** Error simulation (SPEC §4): the injection rules and the bearer-token registry. */
	injection: InjectionService;
	/** The customer service window, throughput, pair rate and messaging limit (SPEC §4). */
	messagingRules: MessagingRules;
	tokens: TokenRegistry;
	/** Control plane (SPEC §5). */
	contacts: ContactService;
	conversations: ConversationService;
	/** The virtual phone's view of the conversations (SPEC §5). */
	phone: PhoneService;
	inbound: InboundService;
	phoneNumbers: PhoneNumberService;
	wabas: WabaService;
	state: StateService;
	reset: ResetService;
	/** State export/import: one JSON file that is a whole whaloc (SPEC §5). */
	snapshots: SnapshotService;
	/** The WebSocket hub subscribes here; services only ever publish. */
	events: EventBus;
	/** Webhook deliveries in flight; the specs and the shutdown sequence wait on it. */
	tasks: BackgroundTasks;
	/** `/api/clock`: the instance's one clock, real or virtual (SPEC §4). */
	clock: ClockService;
	/** Where generated IDs get their bytes: seeded under the virtual clock. */
	ids: IdStream;
	/** `/api/scenarios`: repeatable simulator tests (SPEC §4, "Scenarios"). */
	scenarios: ScenarioRunner;
	/** What the app under test sent to the Graph listener, and what it got back (SPEC §5). */
	graphRequests: GraphRequestLog;
	/**
	 * Public demo mode's anonymous visitors (SPEC §5): built in every mode so the wiring is one
	 * shape, but only public mode mounts its routes and starts its cleanup job.
	 */
	visitors: VisitorSessionService;
}

/** Everything with a lifetime, built once at boot and injected from here on (SPEC §8). */
export interface AppServices {
	db: Kysely<Database>;
	repositories: Repositories;
	mediaStorage: MediaStorage;
	domain: DomainServices;
	seed: SeedResult;
	/** Cancels pending timers and releases the database handle; called by the shutdown sequence. */
	close: () => Promise<void>;
}

function migrationMessage(applied: string[]): string {
	return applied.length === 0 ? "database schema already up to date" : "database migrated";
}

export interface CreateDomainServicesOptions {
	repositories: Repositories;
	mediaStorage: MediaStorage;
	config: AppConfig;
	logger: Logger;
	scheduler?: Scheduler;
	/** Defaults to `crypto` randomness, as before the virtual clock existed. */
	ids?: IdStream;
}

/**
 * Waits until no background task and no webhook retry pass is running — looking again after a
 * tick, because finishing one can start the other (a retry's failure re-arms the queue).
 */
async function settleBackgroundWork(tasks: BackgroundTasks, webhooks: WebhookEmitter): Promise<void> {
	do {
		await tasks.whenIdle();
		await webhooks.whenIdle();
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	} while (tasks.size > 0 || webhooks.isBusy);
}

/**
 * Wires the domain together, in dependency order: the event bus and the background-task
 * tracker first, then the webhook emitter everything announces through, then the two lifecycle
 * services that are also the `OutboundMessageEvents` / `TemplateLifecycleEvents` the Graph
 * services fire (SPEC §4).
 */
export function createDomainServices(options: CreateDomainServicesOptions): DomainServices {
	const { repositories, mediaStorage, config, logger } = options;
	const tasks = createBackgroundTasks(logger);
	const events = createEventBus({
		onListenerError: error => {
			logger.warn({ err: error }, "a websocket listener threw while handling an event");
		},
	});
	const scheduler = options.scheduler;
	const ids = options.ids ?? createRandomIdStream();
	const { random, nextSequence } = ids;
	const virtual = scheduler instanceof VirtualClock ? scheduler : null;
	// The default app is the environment's; registered apps live in the database (SPEC §3).
	const apps = new AppService({
		random,
		repositories,
		defaultApp: {
			id: config.appId,
			callbackUrl: config.webhookUrl,
			appSecret: config.appSecret,
			verifyToken: config.webhookVerifyToken,
		},
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	// Public mode only: logs that would name a visitor who already left are not written.
	const departed =
		config.access.mode === "public"
			? createDepartedNumbers({ repositories, waIdPrefix: config.access.visitors.waIdPrefix })
			: undefined;
	const webhooks = new WebhookEmitter({
		random,
		repositories,
		logger,
		apps,
		events,
		retryScheduleMs: config.webhookRetryScheduleMs,
		retryMaxAgeMs: config.webhookRetryMaxAgeMs,
		nextSequence,
		...(departed !== undefined && { departed }),
		...(scheduler !== undefined && { scheduler }),
	});
	const statusLadder = new StatusLadder({
		repositories,
		webhooks,
		tasks,
		logger,
		delays: config.statusDelays,
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const templateLifecycle = new TemplateLifecycle({
		repositories,
		webhooks,
		tasks,
		logger,
		autoApproveMs: config.templateAutoApproveMs,
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const typing = new TypingService({
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const media = new MediaService({
		random,
		repositories,
		storage: mediaStorage,
		publicUrl: config.publicUrl,
		ttlSeconds: config.mediaTtlSeconds,
		...(scheduler !== undefined && { scheduler }),
	});
	const subscribedApps = new SubscribedAppService({
		apps,
		publicUrl: config.publicUrl,
		destinationsLocked: config.access.mode === "public",
	});
	// The Upload API is scoped to the app `subscribed_apps` reports, so it is built after it
	// (SPEC §2.21); the templates and the business profile both resolve handles through it.
	const uploads = new UploadService({
		random,
		repositories,
		storage: mediaStorage,
		publicUrl: config.publicUrl,
		appId: subscribedApps.identity.id,
		maxBytes: media.maxBytes,
		...(scheduler !== undefined && { scheduler }),
	});
	// The snapshot names the app `subscribed_apps` reports, so that one comes first.
	const state = new StateService({ repositories, config, webhooks, subscribedApps });
	// The WABA cascade goes through the phone numbers, so this one is built first.
	const phoneNumbers = new PhoneNumberService({
		random,
		repositories,
		webhooks,
		tasks,
		mediaStorage,
		logger,
		events,
		...(scheduler !== undefined && { scheduler }),
	});

	const injection = new InjectionService({
		repositories,
		events,
		random,
		nextSequence,
		...(scheduler !== undefined && { scheduler }),
	});
	const messagingRules = new MessagingRules({
		repositories,
		config: config.messaging,
		events,
		...(scheduler !== undefined && { scheduler }),
	});

	const clock = new ClockService({
		config: config.clock,
		scheduler: scheduler ?? createSystemScheduler(),
		virtual,
		ids,
		repositories,
		logger,
		events,
	});

	// An advance is complete once what each event started has settled: the status webhooks it
	// sent, the retries it persisted (SPEC §4, "Virtual clock").
	virtual?.setSettler(async () => {
		await settleBackgroundWork(tasks, webhooks);
	});

	const inbound = new InboundService({
		random,
		repositories,
		webhooks,
		tasks,
		media,
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const reset = new ResetService({
		repositories,
		mediaStorage,
		config,
		logger,
		state,
		statusLadder,
		templateLifecycle,
		typing,
		messagingRules,
		apps,
		webhooks,
		events,
		clock,
	});

	return {
		objects: new ObjectService({ repositories }),
		// An accepted send starts the ladder *and* drops the conversation's typing indicator.
		messages: new MessageService({
			random,
			repositories,
			events: combineOutboundMessageEvents(statusLadder, typing),
			rules: messagingRules,
			statusFailures: injection,
			...(scheduler !== undefined && { scheduler }),
		}),
		readReceipts: new ReadReceiptService({
			repositories,
			typing,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		media,
		uploads,
		templates: new TemplateService({ repositories, events: templateLifecycle, uploads, random }),
		businessProfiles: new BusinessProfileService({ repositories, media, uploads, events }),
		subscribedApps,
		apps,
		webhooks,
		statusLadder,
		templateLifecycle,
		accountEvents: new AccountEventService({
			repositories,
			webhooks,
			...(scheduler !== undefined && { scheduler }),
		}),
		typing,
		injection,
		messagingRules,
		tokens: new TokenRegistry({
			repositories,
			tokens: config.tokens,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		// A number change emits Meta's `user_changed_number` system webhook (SPEC §5), so this
		// one needs the emitter and the clock like every other announcing service.
		contacts: new ContactService({
			random,
			repositories,
			webhooks,
			tasks,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		conversations: new ConversationService({ repositories }),
		phone: new PhoneService({ repositories, statusLadder }),
		inbound,
		phoneNumbers,
		wabas: new WabaService({ repositories, phoneNumbers, events, random }),
		state,
		reset,
		// An import replaces everything a reset would wipe, so it cancels the same timers —
		// but it does *not* re-apply the seed: the snapshot is the state (SPEC §5).
		snapshots: new SnapshotService({
			repositories,
			mediaStorage,
			logger,
			state,
			statusLadder,
			templateLifecycle,
			typing,
			messagingRules,
			webhooks,
			events,
			clock,
			...(scheduler !== undefined && { scheduler }),
		}),
		events,
		tasks,
		clock,
		ids,
		graphRequests: new GraphRequestLog({
			repositories,
			appKeyFor: async token => {
				const app = await apps.forAccessToken(token);

				return app.key;
			},
			events,
			logger,
			...(departed !== undefined && { departed }),
			...(scheduler !== undefined && { scheduler }),
		}),
		visitors: new VisitorSessionService({
			config: config.access.visitors,
			repositories,
			mediaStorage,
			events,
			logger,
			scheduler: scheduler ?? createSystemScheduler(),
			random,
		}),
		scenarios: new ScenarioRunner({
			config,
			repositories,
			reset,
			apps,
			injection,
			inbound,
			messagingRules,
			clock,
			tasks,
			webhooks,
			logger,
		}),
	};
}

/** Everything after the database is open; extracted so the caller's `try` stays trivial. */
async function buildServices(options: CreateServicesOptions, handle: DatabaseHandle): Promise<AppServices> {
	const { config, logger } = options;
	const { db } = handle;
	const { applied } = await runMigrations({ db });

	logger.info({ dbPath: config.dbPath, applied }, migrationMessage(applied));

	// One clock per instance (SPEC §4): a test's scheduler, else the virtual clock when
	// `WASANDBOX_CLOCK=virtual`, else real time inside every service, as before.
	const scheduler =
		options.scheduler ?? (config.clock.mode === "virtual" ? new VirtualClock(config.clock.start) : undefined);
	const ids = scheduler instanceof VirtualClock ? createSeededIdStream() : createRandomIdStream();
	const clock: Clock | undefined = scheduler === undefined ? undefined : () => scheduler.now();
	const repositories = createRepositories(db, clock);
	const seed = await applySeed({ repositories, seed: config.seed, ...(clock !== undefined && { clock }) });

	// The resolved ids — WABAs, phone numbers, contacts and templates — are what a user has to
	// put in `GRAPH_API_BASE_URL` calls, so they are logged in full even when nothing was
	// created (SPEC §7).
	logger.info({ wabas: seed.wabas, created: seed.created }, "seed applied");

	// A directory or an S3 bucket, decided by `WASANDBOX_MEDIA_BACKEND` (SPEC §6); everything
	// downstream only ever sees the interface.
	const mediaStorage = createMediaStorage({ config });

	logger.info({ backend: config.mediaBackend }, "media storage ready");
	const domain = createDomainServices({
		repositories,
		mediaStorage,
		config,
		logger,
		ids,
		...(scheduler !== undefined && { scheduler }),
	});

	// A stored virtual-clock position comes back before the retry queue is armed against it.
	await domain.clock.restore();
	const registeredApps = await domain.apps.applySeed(config.apps);

	if (registeredApps.length > 0) {
		logger.info({ apps: registeredApps.map(app => ({ id: app.id, name: app.name })) }, "apps registered");
	}

	// Retries owed before a restart are owed still (SPEC §3): with a file database the queue is
	// picked up where it was left, overdue ones first.
	await domain.webhooks.resumeRetries();

	// Visitors idle past the TTL while the instance was down are cleaned up now, then on a timer
	// (SPEC §5, "Public demo mode"). Their sockets died with the old process.
	if (config.access.mode === "public") {
		await domain.visitors.sweep();
		domain.visitors.start();
	}

	return {
		db,
		repositories,
		mediaStorage,
		domain,
		seed,
		close: async () => {
			// Timers are in-process and are dropped on shutdown (SPEC §4); deliveries already
			// in flight get a chance to finish so the log is not left mid-attempt.
			domain.statusLadder.cancelAll();
			domain.templateLifecycle.cancelAll();
			domain.typing.clearAll();
			domain.visitors.stop();
			// Pending retries stay in the database for the next boot; only the timer goes.
			domain.webhooks.stop();
			await domain.tasks.whenIdle();
			await handle.close();
			// An S3 client's keep-alive sockets would otherwise hold the process open until the
			// shutdown timeout gives up on them (SPEC §6).
			await mediaStorage.close?.();
		},
	};
}

/**
 * The boot sequence's middle step: open the database, migrate it, seed it, and hand back the
 * repositories, the media storage and the domain services the rest of the server is built on.
 * Keeping it here means `main.ts` stays a script and `app.ts` stays about HTTP.
 */
export async function createServices(options: CreateServicesOptions): Promise<AppServices> {
	const handle = createDatabase({ dbPath: options.config.dbPath });

	try {
		return await buildServices(options, handle);
	} catch (error) {
		await handle.close();

		throw error;
	}
}
