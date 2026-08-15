---
name: semiont-tour
description: Drive a participant's Browser from outside — a timed, branching "guided tour" of a knowledge base: browse --browser moves them to a resource or opens an annotation, beckon offers choices, listen reports where they went
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a **guided tour**: a script that walks a person through a
knowledge base, putting resources on their screen on a schedule, pointing at the annotations
that are worth following next, and branching on where they actually went.

The person stays in control throughout — they can read ahead, wander off, or follow a
reference the script never suggested. That is the point. A tour *suggests and reports*; it does
not take the wheel.

## The two paths, and which one you are on

| | **bus path** | **bootstrap path** |
|---|---|---|
| precondition | a Browser is open and someone is watching | nothing running |
| what happens | the script emits domain signals; the page reacts in-app | a human opens a Browser and logs in |
| how often | every step of the tour | once, at the start |

This skill is about the bus path. For the cold start, see
[`semiont-local`](../semiont-local/SKILL.md) — the launcher deliberately never opens a browser
window or hands it a session (it knows origins, never URLs), so somebody opens the page and
logs in once, and the tour drives from there.

**The tour must authenticate as the same user who is watching.** Signals broadcast to everyone
subscribed to that KB, so running a tour while a colleague reads the same KB will drive their
screen too. There is no per-participant addressing, deliberately — see "What this cannot do".

## The moves

Four drives and one report:

| move | command | channel |
|---|---|---|
| put a resource on their screen | `semiont browse <id> --browser` | `browse:resource-open` |
| **open an annotation** (panel entry + scroll) | `semiont browse --annotation <id> --browser` | `browse:click` |
| offer a branch (no scroll) | `semiont beckon --resource <id> --annotation <id> --sparkle` | `beckon:sparkle` |
| say "start here" (scrolls) | `semiont beckon --resource <id> --annotation <id>` | `beckon:focus` |
| see where they went | `semiont listen --channel browse:resource-viewed` | report |

**`browse` advances the story; `beckon` offers a choice.** This is the shape of a tour, and
getting it backwards is the common mistake. The two `browse --browser` forms are how a guide
moves a participant along on a schedule — to the next resource, or to the passage worth
reading inside it. `beckon` is punctuation: it marks options and lets the participant pick.
A tour built entirely from beckons is not a tour, it is a scavenger hunt — it stalls after
the opening move, waiting for a choice at every step.

**Point versus open.** `beckon:focus` scrolls the viewer to an annotation and stops there.
`browse --annotation --browser` *opens* it: the annotations panel comes up with that entry
selected, and the scroll happens too. Point when you want them to notice something; open when
you want them reading it.

**Sparkle for menus, focus for one thing.** Focus *scrolls the viewer to* the annotation, so
beckoning three references in a row scroll-fights and only the last survives. Sparkle marks an
annotation in place. A three-way branch is three sparkles; "begin here" is one focus.

**The annotation form takes no resourceId** — not on the command line, not on the wire. An
annotation id names exactly one annotation on exactly one resource, so the id is the whole
address; a second id would only be something for you to keep consistent. The launcher rejects
one rather than ignoring it.

**The `browse` moves fail on an empty room; the `beckon` moves do not.** Every emit reports
how many subscribers the target subject had at dispatch, but the two verbs treat zero
differently on purpose: `beckon` exits 0 because a beckon is fire-and-forget, while **both**
`browse --browser` forms exit 1 because each asked for a specific outcome — something on a
screen — and zero subscribers means it did not happen. Under `set -e` that makes every
`browse` move a gate, starting with the first.

## Building the tour

Read the KB first — every verb takes ids, and `browse` is what produces them:

```sh
semiont browse --entity-type Chapter --limit 20 --json | jq -r '.response.resources[] | "\(.["@id"])\t\(.name)"'
semiont browse res-intro --annotations --json | jq -r '.response.annotations[] | select(.motivation=="linking") | .id'
```

Reference annotations (`motivation: "linking"`) are the branch points — they already mean "this
leads somewhere else", which is exactly a tour's next step.

## A working tour

```sh
#!/usr/bin/env bash
set -euo pipefail

# Wait until somebody is actually watching. Presence is CONNECTION lifecycle:
# this fires when a Browser opens an event stream, not when a token is minted.
semiont listen --channel session:joined --json | head -1 >/dev/null

# Fails (exit 1) if nobody is subscribed, so `set -e` stops the tour rather
# than narrating to an empty room. Add --launch to start the Browser when none
# is running — it starts a CONTAINER, and someone must still open a web
# browser and log in.
semiont browse res-intro --browser
sleep 90

# Keep moving: open the passage that matters, don't just point at it. The
# panel comes up with this entry selected and the view scrolls to it.
semiont browse --annotation ann-thesis --browser
sleep 60

# Advance to the next stop on the guide's schedule.
semiont browse res-method --browser
sleep 90

# NOW hand over a choice — this is what beckon is for. Two sparkles mark the
# options without scroll-fighting; one focus says which to start with.
semiont beckon --resource res-method --annotation ref-history --sparkle
semiont beckon --resource res-method --annotation ref-sources --sparkle
semiont beckon --resource res-method --annotation ref-history

# Branch on where they actually went — including arrivals by link, back button,
# or a typed URL, not just cues they followed.
semiont listen --channel browse:resource-viewed --json |
  while read -r ev; do
    case "$(jq -r '.payload.resourceId' <<<"$ev")" in
      res-history) semiont browse --annotation ann-origins --browser ;;
      res-sources) semiont browse res-sources-detail --browser ;;
    esac
  done
```

Note the rhythm: **four `browse` moves carry the tour, one `beckon` cluster offers the
branch.** The guide keeps the story moving on its own schedule and hands over control at the
moment a choice is genuinely interesting — not at every step.

Timing is `sleep`. Semiont has no scheduler and wants none — the tour's pace is the author's.

## Watching it happen

`semiont listen` renders for a human by default and is line-delimited JSON under `--json`:

```
  14:03:12 ● alice@example.com joined  — 1 connection watching
  14:03:20 browse:resource-viewed      resource="The Iliad, Book I"
  14:07:41 ○ alice@example.com left    — 0 connections watching
```

Two things to know about that output:

- **Presence counts connections, not people.** One person with two tabs is two connections. A
  count keyed on identity would report one viewer for two, and none when they closed a duplicate.
- **It is inbound only.** Your own cues are not echoed back, so silence where a cue should
  appear is not evidence the cue failed. `listen` says this on startup.

## Did anyone receive it?

Every emit reports how many subscribers the backend had **at dispatch**:

```
✓ Opened res-42 in the Browser (1 subscriber — broadcast, so still no confirmation anyone looked)
✓ Beckoned toward res-42 (ann-9) — nothing is subscribed to beckon:focus, so no one received it
```

Zero means the signal reached an empty room — worth acting on, because these channels have no
reply and would otherwise fail silently. A positive count is **not** delivery: a subscriber is
a connection, not a pair of eyes.

**Zero is an error for `browse --browser` and a fact for `beckon`**, per the split above:
both `--browser` forms exit 1 (they asked for a specific outcome that did not happen), while
`beckon` exits 0 (fire-and-forget by contract). Under `set -e` that makes any `browse
--browser` a gate and no `beckon` one.

## What this cannot do

State these to the user rather than letting them discover them mid-demo:

- **No per-participant addressing.** Signals go to everyone watching that KB. The tour assumes
  you are driving your own session.
- **No delivery or attention confirmation.** You learn that something was sent and how many
  connections existed. Never that a human looked.
- **No forced navigation to a resource the viewer cannot see.** `beckon:focus` carries a
  `resourceId` as a *guard*: a viewer on a different resource ignores it. Moving someone is
  `browse --browser`'s job, and it is a separate, deliberate act.
- **Opening an annotation the viewer has not loaded does nothing.** It is a silent no-op, not
  an error — the viewer resolves the annotation by id and finds nothing. So open a resource
  before opening an annotation inside it, or accept that the cue may land nowhere.
- **No annotation-level engagement reporting.** You can now *drive* a click, but you still
  only see which **resources** they arrived at — not which annotations they read. The drive
  and the report are asymmetric here, deliberately: `browse:resource-viewed` is the only
  arrival signal.

## From TypeScript instead

The SDK expresses every tour move through `beckon` — the wire drives — plus the arrival
report:

```ts
const n = await client.beckon.openResource(resourceId);   // → wire (browse:resource-open)
await client.beckon.click(annotationId);                  // → wire (browse:click)
await client.beckon.sparkleAll(annotationId);             // → wire (beckon:sparkle)
await client.beckon.attention(resourceId, annotationId);  // → wire (beckon:focus)
client.browse.resourceViewed(resourceId);                 // → wire (the report)
```

The pairing is the rule worth remembering: **`browse.X()` does it for me, `beckon.X()` does
it for everyone else.** `browse.openResource()` and `browse.click()` are this viewer's own
local fan-out; their `beckon` twins are the wire drives a tour uses.

Every drive resolves with the subscriber count (`-1` = unknown) — the same signal the
launcher's tour verbs print. `n === 0` means the room is empty, and the script can say so
instead of touring nobody.

The unmarked local members stay local by design: `browse.openResource()`, `browse.click()`
and `beckon.sparkle()` are this viewer's own fan-out — from a Node script they reach nobody,
and that is correct. A wire emit there would broadcast one viewer's own click to the whole
room, which is the drive-versus-report loop the split exists to prevent.

For anything long-running, build on [`semiont-session`](../semiont-session/SKILL.md) rather
than a bare client: a tour that outlives its access token needs the refresh machinery, and
`session.subscribe(channel, handler)` is the SDK equivalent of `semiont listen`.

**Either surface drives a tour.** The launcher's moves are one command each with no
token lifecycle to own; the SDK path is the same wire with a programmable driver around it.

## Related

- [`semiont-local`](../semiont-local/SKILL.md) — get a KB and a Browser running first.
- [`semiont-session`](../semiont-session/SKILL.md) — long-running SDK scripts, token refresh.
- [Beckon flow](../../flows/BECKON.md) — attention coordination, including the in-browser half.
- [Browse flow](../../flows/BROWSE.md) — navigation intent vs framework routing.
