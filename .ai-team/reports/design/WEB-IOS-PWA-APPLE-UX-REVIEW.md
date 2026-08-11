# WEB-IOS Apple UX and Motion Review

**Scope:** final source and local-browser review of the active PWA and Electron renderer on 2026-08-10. Physical iPhone, VoiceOver, native Electron accessibility, and packaged-runtime checks were not executed.

## Reference compliance

The final reviewer read Apple Design, Emil Design Engineer, Animation Vocabulary, Improve Animations and its audit guide, Review Animations and its standards, and Logo Designer from the extracted reference tree. The implementation applies their task-first hierarchy, existing-brand preservation, immediate 100-160 ms strong ease-out feedback, transform/opacity preference, pointer-gated hover, and reduced-preference rules.

## Source verdict

**Source-level approve; physical Apple-platform sign-off remains open.**

The earlier P1 findings are remediated:

- A dedicated concise live status replaces broad high-frequency announcement churn; numeric scan/progress metrics are non-live.
- Focus follows meaningful route/terminal/camera-error headings.
- Known button, eyebrow, supporting-text, and definition-label contrast pairs were corrected.
- PWA safe areas are additive on all four edges, actions remain in flow, and controls tolerate wrapping/text growth.
- Press feedback uses 120-140 ms strong ease-out timing, hover is pointer-gated, and reduced motion suppresses transforms.
- Electron camera access is user-initiated with inline recovery; async and terminal states are explicit; active cancel is confirmed.
- The QR/camera surfaces are static and high contrast, with no decorative looping motion.
- Existing DEQR branding is preserved and rendered PNG exports now cover 16/32/64/180/192/512 pixels.

## Local visual evidence

At a 390x844 in-app browser viewport, the PWA home and camera-unavailable/retry flows rendered without horizontal overflow. Heading focus and 48-pixel actions were observable. The test browser had no camera, so no optical, sustained-scan, verification, export, or installed-standalone behavior was established.

## Remaining Apple-platform checks

- Physical iPhone portrait/landscape safe areas, status/splash treatment, Home Screen icon mask, installed standalone launch, and offline relaunch.
- VoiceOver state announcements, focus, modal behavior, and Share/Files export.
- Dynamic Type/text zoom extremes, Reduce Motion, Reduce Transparency, Increase Contrast, light appearance, and dark appearance.
- Physical camera permission/retry and sustained optical scanning.

Until those checks pass, this document is not an Apple-platform acceptance certificate.
