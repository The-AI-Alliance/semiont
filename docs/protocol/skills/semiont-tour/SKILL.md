---
name: semiont-tour
description: Drive a participant's Browser from outside — a timed, branching "guided tour" of a knowledge base using browse --browser, beckon, and listen
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

## The four moves

| move | command | channel |
|---|---|---|
| put a resource on their screen | `semiont browse <id> --browser` | `browse:resource-open` |
| offer a branch (no scroll) | `semiont beckon --resource <id> --annotation <id> --sparkle` | `beckon:sparkle` |
| say "start here" (scrolls) | `semiont beckon --resource <id> --annotation <id>` | `beckon:focus` |
| see where they went | `semiont listen --channel browse:resource-viewed` | report |

**Sparkle for menus, focus for one thing.** Focus *scrolls the viewer to* the annotation, so
beckoning three references in a row scroll-fights and only the last survives. Sparkle marks an
annotation in place. A three-way branch is three sparkles; "begin here" is one focus.

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

semiont browse res-intro --browser
sleep 90

# The branch menu: mark both paths, then point at one as the suggested start.
semiont beckon --resource res-intro --annotation ref-history --sparkle
semiont beckon --resource res-intro --annotation ref-method  --sparkle
semiont beckon --resource res-intro --annotation ref-history

# Branch on where they actually went — including arrivals by link, back button,
# or a typed URL, not just cues they followed.
semiont listen --channel browse:resource-viewed --json |
  while read -r ev; do
    case "$(jq -r '.payload.resourceId' <<<"$ev")" in
      res-history) semiont beckon --resource res-history --annotation ref-sources --sparkle ;;
      res-method)  semiont browse res-method-detail --browser ;;
    esac
  done
```

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
a connection, not a pair of eyes. Both cases exit 0; an empty room is a fact, not an error.

## What this cannot do

State these to the user rather than letting them discover them mid-demo:

- **No per-participant addressing.** Signals go to everyone watching that KB. The tour assumes
  you are driving your own session.
- **No delivery or attention confirmation.** You learn that something was sent and how many
  connections existed. Never that a human looked.
- **No forced navigation to a resource the viewer cannot see.** `beckon:focus` carries a
  `resourceId` as a *guard*: a viewer on a different resource ignores it. Moving someone is
  `browse --browser`'s job, and it is a separate, deliberate act.
- **No annotation-level engagement reporting.** You see which resources they arrived at, not
  which annotations they read.

## From TypeScript instead

The SDK covers half of this today, and the halves are not obvious:

```ts
client.beckon.attention(resourceId, annotationId); // → wire (beckon:focus)
client.browse.resourceViewed(resourceId);          // → wire (the report)

client.browse.openResource(resourceId);            // LOCAL bus only
client.beckon.sparkle(annotationId);               // LOCAL bus only
```

`openResource` and `sparkle` are in-browser fan-out helpers — from a Node script they reach
nobody. To drive a tour from TypeScript, use the documented escape hatch:

```ts
void client.transport.emit('browse:resource-open', { resourceId });
void client.transport.emit('beckon:sparkle', { annotationId });
```

For anything long-running, build on [`semiont-session`](../semiont-session/SKILL.md) rather
than a bare client: a tour that outlives its access token needs the refresh machinery, and
`session.subscribe(channel, handler)` is the SDK equivalent of `semiont listen`.

**Recommend the launcher for tours.** The shell path is what these channels were built and
verified against, the four moves are one command each, and there is no token lifecycle to own.

## Related

- [`semiont-local`](../semiont-local/SKILL.md) — get a KB and a Browser running first.
- [`semiont-session`](../semiont-session/SKILL.md) — long-running SDK scripts, token refresh.
- [Beckon flow](../../flows/BECKON.md) — attention coordination, including the in-browser half.
- [Browse flow](../../flows/BROWSE.md) — navigation intent vs framework routing.
