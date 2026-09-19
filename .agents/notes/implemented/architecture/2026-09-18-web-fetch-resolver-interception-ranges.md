# Agent Note: Accept declared resolver-interception ranges in web fetch

Status: implemented

English | [中文](2026-09-18-web-fetch-resolver-interception-ranges.zh.md)

## Problem

`web-fetch-http` refuses every answer that `ipaddr.js` does not classify as globally reachable unicast, because the model chooses the URL and a private, loopback, or link-local destination would expose local services. A deployment whose resolver intercepts names — a VPN client running a TUN with a fake-IP pool — answers every query with an address from that pool. The destination is therefore never the address the provider validates: the tunnel routes the placeholder to a proxy that resolves the real origin remotely. `dig example.com` returning `198.18.0.12` made every fetch fail with `WEB_BLOCKED_URL` while `curl` to the same URL succeeded, so the check rejected working network configurations without protecting anything the model could reach.

## Decision

`web-fetch-http` gains the validated config field `resolverInterceptionRanges` (default `[]`). Answers inside a declared range are accepted as destinations; the connection stays pinned to the validated set, and the address policy is otherwise unchanged. Entries must be IPv4 CIDRs wholly inside `198.18.0.0/15` (RFC 2544 benchmarking) or `240.0.0.0/4` (reserved): both pools are unroutable on the public internet and never name a local service, so a declaration cannot open loopback, private, link-local, carrier-grade-NAT, or ULA space. Malformed, non-IPv4, or out-of-pool entries fail at plugin construction. IP literals are never treated as intercepted, because a literal states its destination instead of having one resolved. Deployments declare their pool in a profile patch:

```yaml
- id: web-fetch-http
  config:
    resolverInterceptionRanges: ['198.18.0.0/15']
```

## Alternatives considered

**Accept the benchmarking range unconditionally.** That widens a security policy for every deployment to serve one networking style, and it cannot cover deployments whose client chooses a different pool.

**Detect the interception.** Nothing observable distinguishes a fake-IP pool from a genuinely misconfigured or hostile answer; inferring the intent would make the refusal unpredictable.

**Configure a proxy instead so fetches skip address validation.** That path already exists, but this deployment's client exposes no local proxy port, and it would move DNS policy out of the harness.

## Consequences

A fetch through an intercepted resolver now reaches the origin through the deployment's own routing, which is what the operator intended. The declaration is deployment-scoped rather than global, and a deployment that does not declare a range keeps the previous refusal exactly. Verification covers construction-time validation, acceptance only inside a declared range, the literal exemption, and the resolver wiring.
