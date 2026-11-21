# Using the console

What each page of the console and the virtual phone shows, and how to read windows, statuses,
templates, webhooks and request logs. Everything here is on the console port (8025 by default).

**On this page:** [Find your way around](#find-your-way-around) · [Chats](#chats) ·
[Templates](#templates) · [Webhooks](#webhooks) · [Requests](#requests) · [Clock](#clock) ·
[Scenarios](#scenarios) · [Settings](#settings) · [The virtual phone](#the-virtual-phone) ·
[Public demo mode](#public-demo-mode)

## Find your way around

Open <http://localhost:8025>. One top bar holds:

- the **scope**, a breadcrumb `WABA ▾ / number ▾`. Each part is a menu of what exists, ending in
  "Create WABA…" or "Add number…", so an empty instance can be filled in from the bar;
- the tabs: **Chats**, **Templates**, **Webhooks**, **Requests**, **Clock**, **Scenarios**,
  **Settings**;
- the **simulator clock**, in your browser's time zone (named in its badge);
- live indicators: where webhooks go (or "webhooks: not sent"), and a pulsing
  "N rules injecting errors" badge while any error rule can still fire. Click the badge to reach
  the rule.

Every view updates live over a WebSocket; nothing polls. The scope is in the URL, so a link or a
reload lands where you were:

| View      | URL                                                                                    |
| --------- | -------------------------------------------------------------------------------------- |
| Chats     | `/w/{waba-id}/p/{phone-number-id}/chats/{contact-wa-id}` (the last two parts optional) |
| Templates | `/w/{waba-id}/templates`                                                               |
| Webhooks  | `/webhooks`                                                                            |
| Requests  | `/requests`                                                                            |
| Clock     | `/clock`                                                                               |
| Scenarios | `/scenarios`                                                                           |
| Settings  | `/settings`                                                                            |

`/`, `/chats` and `/templates` open the scope this browser used last. A link to a WABA or number
that no longer exists (deleted, or gone after a reset) moves to the closest one that does, and
says so.

Every time the console shows is **simulator time**, read from the server, not your computer's
clock. With a virtual clock it stands still until you move it.

## Chats

The conversations of one business number, like a messenger. You act as the **WhatsApp user**;
your app is the business.

**Send as the user.** The composer sends text, media, location, reactions, interactive replies,
template button payloads, contact cards and an "unsupported" message (Meta's placeholder for
something WhatsApp cannot show, code `131051`). The collapsed **Extras** panel adds how a message
arrived: forwarded, frequently forwarded, a click-to-WhatsApp `referral`, a `referred_product`.

**Answer what the app sent.** Tap a reply button or a list row in an interactive message, or a
quick reply in a template: the reply goes to your app quoting that message. A `cta_url` button
opens its link.

**Read the ticks** on messages your app sent:

| Tick                | Status      | What happened                                                     |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| clock               | accepted    | WaSandbox accepted the send; no status yet                           |
| one check           | `sent`      | The `sent` status webhook went out                                |
| two checks          | `delivered` | The `delivered` status webhook went out (800 ms later by default) |
| two coloured checks | `read`      | Marked read, by hand or by `read:<ms>` in `WASANDBOX_STATUS_DELAYS`  |
| cross               | `failed`    | Failed; hover it for Meta's error code and title                  |

Each outgoing message has the manual part of the ladder: **mark delivered**, **mark read**, or
**fail** with one of Meta's error codes. On the user's messages, a faint double check means your
app sent a read receipt for it. A typing bubble (and `typing…` in the list) means your app has a
typing indicator up; it goes after 25 seconds or with the app's next message.

**Read the service window badge** in the header:

| Badge                                            | Meaning                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Service window open until …                      | Your app may send free-form messages; the time left is shown |
| Service window closed …: templates only          | 24 hours passed since the contact's last message             |
| Service window expired by hand …: templates only | Someone pressed **Expire now**                               |
| No service window: templates only                | The contact has never written                                |
| Service window not enforced                      | `WASANDBOX_SERVICE_WINDOW=off`                                  |

While the window is not open, a free-form text from your app is accepted and then fails with
`131047`; templates still go out. The window opens when the contact writes and closes 24 hours
after their latest message. **Expire now** closes it for this contact and this number only,
without moving the clock; their next message opens it again.

The header also shows the contact's business-scoped user ID (BSUID) if it has one,
**Changed number…** (moves the contact to a new number and sends Meta's `user_changed_number`
webhook), and **Open phone**, which opens the virtual phone as this contact in this chat.

## Templates

The review a Meta moderator would do, per WABA. Each template shows its status, category,
language and quality, its components as JSON next to a preview that marks every `{{placeholder}}`
and shows a media header from the image it was created with.

- **Approve**, **Reject** (with a reason, sent as `rejection_info`), **Pause**, **Disable**, and
  **push a quality update**. Each one sends the matching template webhook.
- The filter bar (search, status, category) filters **on the server**, with the same filters the
  Graph listing takes.

A template your app creates is `PENDING`, then approved automatically after 2 seconds unless
`WASANDBOX_TEMPLATE_AUTO_APPROVE=off`. A send needs it `APPROVED`, with the same name, language and
number of parameters.

## Webhooks

Every delivery attempt, newest first. Expand a row to see the exact signed body and headers.

| Outcome     | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `delivered` | The receiver answered `200`. Only `200` counts, as on Meta                |
| `retrying`  | It failed (any other status, an error, a timeout); another attempt is due |
| `failed`    | It failed and no attempt is left                                          |
| `skipped`   | The app has no URL; nothing was sent, but the payload is kept             |

**"Signature generated" is not "verified".** WaSandbox signed the body with the app's secret and sent
`X-Hub-Signature-256`. Whether your receiver checked it, WaSandbox cannot see; it sees only the
status your receiver answered. "unsigned" means the app has no secret.

Each row also shows which app it went to and when the next retry is due.

- **Cancel retry** stops the automatic retries of that delivery.
- **Redeliver** is a manual, new send of the stored body to the app's **current** URL, signed
  with its current secret. It starts a new chain; it is not one of the retries.
- **Verify webhook** runs the `hub.challenge` handshake; the raw sender posts any JSON, signed.

Details: [Webhooks](webhooks.md).

## Requests

Every request your app made to the Graph port, rejected ones included: method, path, status,
Meta error code, time taken, the phone number ID and the app the token belongs to. Expand one
for headers and bodies.

- **Tokens are masked**: the bearer token shows only its last four characters, and any header,
  query or JSON key that looks like a secret (`token`, `secret`, `password`, `signature`,
  `api_key`, …) shows `[masked]`.
- **Some bodies are not stored.** A body that does not parse as JSON or a form could hide a
  secret anywhere, so only its type, size and the reason are kept ("omitted"). Uploaded files
  are described, never stored.
- **It is bounded**: the newest 500 requests, each body cut at 16,384 characters.
- **Download JSON** exports the log. Masking does not hide message text or phone numbers, so
  treat the file as private data.
- It is cleared by a reset and by **Clear the log**. It is not part of a snapshot. Calls to port
  8025 are not logged here.

This is the quickest way to tell "my app sent the wrong thing" from "wasandbox answered wrongly".

## Clock

The mode (`real` or `virtual`), the simulator time, the start time and the pending events. With
a virtual clock you can **advance** by a duration, **set** a date and time, or **run to the next
event**; the page lists what each move ran. With the real clock the controls are locked and say
why. How the clock behaves: [Testing → Move time](testing.md#move-time-with-the-virtual-clock).

## Scenarios

Load a scenario file, paste JSON, or pick a shipped example. **Check** validates it without
changing anything. **Run…** warns you first, because a run **resets the whole instance**, then
shows each step as passed, failed or skipped, the expected and observed values of a failed step,
and a **Download JUnit XML** button. [Testing → Scenarios](testing.md#run-scenarios).

## Settings

- **IDs** of every WABA and phone number, with copy buttons: what your app's configuration needs.
- **Accounts and numbers**: add, rename and delete WABAs and numbers (destructive actions say what
  goes with them), status and verification badges, quality and throughput, the business profile,
  and, while a Graph `request_code` is open, the code WaSandbox "texted".
- **Account webhooks** per WABA: send `account_update` or `business_capability_update`. These
  are events only; they change no state.
- **Apps & webhooks**: which apps get a WABA's webhooks, where each copy goes (number override,
  then WABA override, then the app's URL), which app a Graph call counts as (the one whose token
  it sends), the credentials each app has set (never their values), and a handshake per app.
- **Contacts**: name, role, BSUID, display number, and change number.
- **Error injection**: arm a rule, watch its countdown, delete it.
- **Access tokens**, when `WASANDBOX_TOKENS` is set: expire or restore each one.
- **Configured behavior**: what the environment set.
- **Danger zone**: **Export** (a snapshot file), **Import** (replaces everything) and **Reset**
  (back to the seed). All three are explained in
  [Configuration → What survives what](configuration.md#what-survives-what).

## The virtual phone

<http://localhost:8025/phone> is WhatsApp from the **user's** side, one person per browser tab.

1. **Pick who you are.** Every contact is listed with its name, role and number.
2. **Open a business chat.** Every business number is listed.
3. **Type and send.** Your message goes to your app as a signed inbound webhook. Your app's replies
   appear live; your own messages show their ticks.
4. **Tap** an interactive reply button, a list row or a template quick reply to answer it.

Your app writes every reply. WaSandbox never answers on its own: with no receiver configured, or a
receiver that does not reply, the message is stored and shown and nothing comes back. The
console's top bar names the receiver, or says "webhooks: not sent".

While a chat is open in a visible tab, the business's messages are marked **read** as they are
delivered, and your app gets the `read` status webhooks. Each tab keeps its identity in its URL
(`/phone?as=<wa_id>&chat=<phone-number-id>`), so several tabs are several people.

Roles and display numbers come from the seed or from **Settings → Contacts**. They are labels
only; no webhook or Graph answer carries them. In dev mode there is no login.

## Public demo mode

With `WASANDBOX_MODE=public`, anonymous visitors use the virtual phone and only the admin sees the
console.

**A visitor**, at `/phone`:

1. Presses **Start demo** and gets new numbers of their own (by default a customer and a
   technician, starting with `999`). Nobody else's numbers or chats are ever shown.
2. Chats with your app. Text, images and PDFs go to it as signed webhooks; its replies and buttons
   come back live.
3. Sees limits explained in place: too many messages, a file too large or of the wrong type.
4. After 30 minutes without activity, or on **Leave demo**, the session ends and its numbers,
   messages and uploads are deleted. The page offers a new demo.

**The admin** signs in at `/admin` with `WASANDBOX_ADMIN_TOKEN`, and then has the whole console.
Without it, every console page is `404` and every console API is `401`. Ten wrong tokens from one
address within 15 minutes lock that address out for the rest of the window, even with the right
token; the form says "Too many wrong tokens".

Setting it up and putting it behind HTTPS: [Deployment](deployment.md). Route by route:
[access rules](access.md).
