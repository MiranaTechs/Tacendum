# Contributing

Thank you for looking. Two things to read before you open a pull request: the
licensing terms below, which are not optional, and the short note on what this
project is careful about.

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

**Why this is here rather than assumed.** A store permission of this kind —
today the App Store permission in `COPYING.iOS`, and any analogous grant for
a distribution channel Mirana Technologies Inc. designates (term 2 above) —
can only be granted over code the project holds rights to. *(Widened
2026-08-16 together with term 2: a rationale narrower than the grant it
justifies would be support the grant does not have. Term 2's transitional
rule is part of the same honesty — the widening binds submissions from its
date forward, and anything submitted earlier needs re-assent, because
history cannot prove no earlier submission exists.)* One
merged contribution without that grant makes the permission unretrofittable
without tracing every contributor and getting each to agree — which is a
years-long problem, not a paperwork one. VLC spent years on exactly this.
Asking up front costs nothing; asking afterwards may cost the ability to ship
at all.

## What this project is careful about

This is an end-to-end encrypted messenger. A few rules are load-bearing, and a
change that breaks one will be declined however good it otherwise is:

- **No new cryptography.** Protocol crypto comes from libsignal. Not a hand-
  rolled ratchet, not a clever nonce scheme, not "just" a KDF. If a change
  needs a cryptographic primitive that is not already in use, that is a
  discussion before it is a pull request.
- **Plaintext never reaches a log.** Not in an error message, not in a crash
  report, not behind a debug flag.
- **A duress session is network-silent.** No socket, no REST call, no push
  registration. If your change adds a network call, check that it cannot run
  in duress mode.
- **Tests must be able to fail.** A test that passes whether or not the code is
  correct is worse than no test, because it is read as coverage. If you add
  one, break the code on purpose and confirm the test goes red — and say so in
  the pull request. Several defects in this codebase survived a green suite
  that was asserting about itself.

## Practicalities

```bash
pnpm install
pnpm test                 # workspace suites
cd app && npx jest        # the iOS app's suite
pnpm typecheck && pnpm lint
```

The commands above are the complete contributor loop. End-to-end release
verification runs against deployment infrastructure that is not part of this
repository; a pull request is not expected to run it.

Comments in this codebase are load-bearing: where one states what was
rejected, what went wrong the first time, or why the obvious approach was not
taken, that is the design reasoning speaking. Do not strip that reasoning in
a cleanup, and if a change contradicts it, say so in the pull request.

## Reporting a security problem

Please do not open a public issue. Email **security@tacendum.com**. Reporting
terms are at <https://tacendum.com/security/#report>.
