# Agent Note: Engine-native JSON prototype validation

Status: implemented

English | [中文](2026-09-05-engine-native-json-prototype-validation.zh.md)

## Problem

WebKit prints intrinsic constructors with newlines around `[native code]`, while V8 prints spaces. A JSON validator comparing against a literal V8 string rejects ordinary WebKit objects. Assistant stream replay then interrupts the conversation subscriber and leaves the chat body empty even when the backend supplies valid history.

## Decision

`hasIntrinsicConstructor` compares a candidate's native source with the current engine's `Object` or `Array` constructor. Constructor name, prototype identity, and prototype ancestry checks remain mandatory. Historical [Session migrations](../architecture/2026-08-31-released-session-format-migrations.md) and browser replay therefore apply the same lossless JSON rules without assuming V8 formatting.

## Alternatives considered

**Accept every constructor with the expected name.** Rejected because user-defined constructors can forge that name and prototype linkage.

**Skip JSON validation during browser replay.** Rejected because the stream is decoded from a process-external transport and still needs structural validation.

## Consequences

Plain cross-realm containers remain accepted and forged prototypes remain rejected. Unit coverage exercises multiline native representations and forged prototypes; real WebKit history replay checks the assembled browser path. The validator assumes the engine intrinsics are trusted.
