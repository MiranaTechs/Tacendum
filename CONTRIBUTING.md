# Contributing

Before opening a pull request, read the contribution terms and the security
constraints below.

## The terms

By submitting a contribution to this repository, you agree that:

1. You license your contribution under **AGPL-3.0-only**, the same license as
   the rest of the project.
2. You grant Mirana Technologies Inc., over your contribution, an additional
   permission under section 7 of the AGPL of the same kind as the one in
   `COPYING.iOS`, stated here generically rather than by incorporation: for
   **distribution of the combined work in object-code form through any
   app-store distribution channel Mirana Technologies Inc. designates** —
   today that set is the Apple App Store and Google Play — compliance with
   the designated channel's terms of service is not to be treated as a
   further restriction under section 7 with respect to your contribution.
   You further grant Mirana Technologies Inc. the **authority to regrant
   that permission over your contribution, as part of the combined work**,
   in the project's store-permission files — `COPYING.iOS` today, and any
   analogous file for a later-designated channel, such as
   `COPYING.Android` (in force) for Google Play.
   *(Rewritten 2026-08-16. The previous term incorporated `COPYING.iOS` by
   reference — a grant that is Apple-specific and expressly limited to
   Mirana-copyrighted material, so it could not unambiguously carry a Google
   Play permission over contributor-owned material. Transitional rule: any
   contribution **submitted before this term's adoption** (2026-08-16, the
   commit that introduced this sentence — a submission earlier the same day
   still predates it and is covered) — merged or not, including any pull
   request then open or since closed — was assented under the Apple-only
   term, and requires the submitter's re-assent to this term before it may
   be merged or distributed under the widened grant. Git history showing no
   merged external contribution does not close that gap; this sentence is
   what closes it.)*
3. You have the right to do both — the work is yours to license, or your
   employer has authorised it.

If you do not agree to all three, please do not submit the contribution.

The additional permission can cover only code for which the project holds the
necessary rights. Collecting the grant when a contribution is submitted keeps
the applicable distribution permissions clear. The transitional rule in term
2 addresses submissions made before the widened term took effect.

## What this project is careful about

Changes must preserve these security properties:

- **Use the existing cryptography.** Protocol cryptography comes from
  libsignal. Discuss any new primitive before opening a pull request.
- **Keep plaintext out of logs.** This includes errors, crash reports, and
  debug output.
- **Keep duress sessions network-silent.** They must not open sockets, make
  REST calls, or register for push. Check every new network path.
- **Prove new tests can fail.** Temporarily break the relevant behavior,
  confirm the test fails, and include that result in the pull request.

## Practicalities

Run the full workspace suite only in an isolated local development
environment. Some Vitest files use DynamoDB Local, the active Docker context,
and installed or credentialed coding-agent binaries. Do not point the suite at
shared or hosted services.

```bash
pnpm install
pnpm test                 # workspace suites
pnpm --dir app exec jest --ci
pnpm typecheck && pnpm lint
```

Run the checks above for a pull request. Preserve comments that document
security constraints, and call out any change that intentionally revises one.

## Reporting a security problem

Please do not open a public issue. Email **security@tacendum.com**. Reporting
terms are at <https://tacendum.com/security/#report>.
