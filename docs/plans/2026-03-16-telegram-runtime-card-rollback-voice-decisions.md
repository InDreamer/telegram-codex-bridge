# Telegram Runtime Card, Rollback, And Voice Decisions

**Date:** 2026-03-16

**Status**

Planning document capturing discussion decisions that are not yet shipped behavior.

**Purpose**

Preserve the decisions already made for:

- runtime-card status-line customization
- `/inspect` expansion and collapse behavior
- `/rollback` target selection UX
- voice-input direction

This document is a planning checkpoint, not an active product spec.

## Observed Baseline

Current Telegram command surface includes:

- `/status`, `/where`, `/inspect`
- session commands such as `/new`, `/sessions`, `/use`, `/archive`, `/unarchive`, `/rename`, `/pin`
- thread-control commands such as `/review`, `/fork`, `/rollback`, `/compact`, `/thread`, `/interrupt`
- rich-input commands such as `/local_image` and `/mention`

Current Telegram runtime surfaces already include:

- one runtime status card for active work
- plan expand and collapse controls on that runtime card
- agent expand and collapse controls on that runtime card
- persisted expand and collapse controls for oversized final answers

Current gaps relevant to this discussion:

- no user-configurable runtime-card status-line field selection
- `/inspect` can become too long and does not currently have the same expand and collapse treatment as oversized final answers
- `/rollback` is quantity-based and does not expose a user-facing target selector
- voice input is not yet implemented in the bridge

## Decision Summary

### 1. Runtime-card status line

The new status-line concept should not become a new standalone status surface.

Decision:

- keep `/status` focused on service health only
- add a configurable status-line section inside the existing runtime card
- do not move this content into `/status` for now

Configuration model:

- configuration is global, not per session
- configuration is managed through a dedicated command entrypoint rather than being hidden inside `/status`, `/where`, or `/inspect`
- the user chooses visible fields through a selection flow with buttons
- the display order follows the user's selection order
- if selection order is used, the UI should tell the user that selection order is also display order
- long status-line content may wrap onto additional lines
- the first version of this configuration flow should do field selection only, not broader display-density or pagination settings
- saving the new selection should refresh the currently visible runtime card immediately

Field-pool principle:

- expose as many truthful fields as the bridge can provide
- the user decides which of those fields they want to see
- if a field is unavailable at render time, omit it instead of showing fake or placeholder data
- do not invent approximate values for fields that imply precision

Field examples explicitly discussed:

- session name
- project name
- project path
- model plus reasoning effort
- recent turn status
- thread id
- turn id
- context-window total
- recent token-usage snapshot
- cumulative token usage
- remaining context only when an exact value is actually available
- blocked reason only when it carries real meaning such as waiting for approval or waiting for user input
- current step or progress only when it carries real meaning beyond empty filler text
- final-answer readiness only when it proves useful in practice

### 2. `/inspect` long-output handling

Decision:

- keep `/inspect` as the detailed inspection surface
- default output stays expanded rather than collapsed
- add collapse support
- add pagination when the content is too large

Intent:

- avoid spamming the Telegram chat with one huge inspection dump
- keep the detailed view accessible without forcing the user to open a separate command or separate debug surface

### 3. `/rollback` target selection

Decision:

- stop making the user reason about "rollback by count" as the main UX
- present rollback targets as a list of user inputs
- show each target as `sequence number + truncated user input`
- support pagination or folded history so the list can cover the full history instead of an arbitrary tiny subset
- require a confirmation step before executing rollback

Important scope rule:

- rollback target selection should be based on user inputs only
- do not attempt to summarize agent output in order to build rollback choices

Implementation direction:

- the bridge may still convert a selected rollback target into the underlying quantity-based rollback request
- the quantity-based protocol detail stays internal to the bridge UX

### 4. Voice input

Decision:

- support both API-based transcription and app-server realtime audio
- if the user provides API configuration, API transcription is the primary path
- if API transcription fails, the bridge should automatically fall back to app-server realtime audio
- if the user does not provide API configuration, the bridge should still use app-server realtime audio
- the first shipped voice scope is voice input only, not voice reply output

Configuration direction:

- installation is handled through the repository skill flow
- the install flow may ask whether voice input should be enabled
- the install flow may ask whether the operator wants to configure an API-backed transcription path
- voice configuration belongs in install or server-side configuration, not casual Telegram chat setup
- API credentials should only be managed through install or local server-side configuration, not through Telegram chat

Important protocol note:

- the current Codex app-server schema on the local host exposes realtime audio requests and notifications
- that realtime audio surface is marked experimental in the generated schema
- protocol presence does not mean the current bridge already implements it

Voice UX decisions:

- API transcription should auto-send the transcript to Codex instead of waiting for confirmation
- the bridge should echo the recognized transcript back to the user
- when a voice-originated task appears in rollback selection, it should render as `语音：{truncated transcript}`
- when the bridge automatically switches from API transcription to realtime audio, it should send a short explicit notice
- the first version should not add an extra bridge-level voice-duration limit beyond Telegram's own practical input limits

## Explicit Non-Decisions

These points are intentionally not finalized yet:

- the final command name or entrypoint for editing runtime-card status-line fields
- the exact button flow for field selection
- the final storage shape for global runtime-card field preferences
- how many `/inspect` pages should be rendered at once
- whether `/inspect` expansion and collapse should reuse persisted-message patterns from final answers or use a lighter transient flow
- whether rollback choices should be sourced only from bridge-recorded user input, from thread history, or from a merged approach
- whether the bridge should support voice-reply output in a later phase and how that should coexist with normal final-answer text
- which API provider or providers should be supported
- how token validation, secure storage, rotation, and failure messaging should work
- how Telegram voice formats should be adapted for the realtime-audio fallback path

## Discussion Direction For Next Pass

The next discussion pass should focus on the unresolved details instead of reopening the decisions above.

Recommended next topics:

1. runtime-card status-line configuration flow and storage
2. `/inspect` pagination and persistence behavior
3. rollback-source strategy for building the user-input target list
4. voice-routing policy when both API and realtime-audio paths are configured
5. API credential handling during skill-based install
