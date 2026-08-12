# DEQR iOS Device Validation — Environment and Build Evidence

## Repository identity

- Branch: `codex/ios2-shell`
- HEAD: `5bc15861df222f361ee718f799d0d06ec8f766d9`
- Scope: iOS/mobile only; desktop acceptance remains suspended.

## Host environment observed

- Windows: Windows 10, version `10.0.19045`, build `19045`.
- .NET SDK: `10.0.302` at `C:\Program Files\dotnet\dotnet.exe`.
- .NET MAUI workload after remediation: `maui` version `10.0.20/10.0.100`, installed from SDK `10.0.300`.
- Visual Studio: no Visual Studio 2022 IDE was detected. Visual Studio Build Tools 2026
  `18.8.2` was detected; it is not an iOS Local Device/Hot Restart IDE workflow.
- iTunes Microsoft Store package: installed.
- Apple Mobile Device service: not detected.
- Apple/iPhone USB device: not detected by present-device enumeration.
- Trusted device, Developer Mode, Apple account, provisioning status, iPhone model, and
  iOS version: not observable because no physical iPhone was detected.

## Application configuration inspected

- Target framework: `net10.0-ios`.
- Bundle identifier: `com.mohammadabwini.deqr.receiver`.
- `NSCameraUsageDescription`: declared.
- `UIFileSharingEnabled`: enabled.
- `LSSupportsOpeningDocumentsInPlace`: enabled.
- Entitlements file: none present.
- Explicit iOS signing configuration: none present in the project file.

## Executed platform-independent build and test

Command:

```powershell
& 'C:\Program Files\dotnet\dotnet.exe' test `
  'mobile\tests\DEQR.Core.Tests\DEQR.Core.Tests.csproj' `
  --configuration Release --verbosity normal
```

Observed result:

- Build: `PASS`, 0 warnings, 0 errors.
- Test run: `PASS`, 27/27 tests.
- Coverage included desktop-generated deterministic frame fixtures, raw-frame parsing,
  duplicate suppression, out-of-order reconstruction, malformed/mixed-session rejection,
  gzip reconstruction bounds, SHA-256 validation, filename sanitization, and
  collision-safe received-file storage.

## MAUI application builds

Commands executed with `C:\Program Files\dotnet\dotnet.exe`:

```powershell
dotnet build mobile\src\DEQR.Mobile\DEQR.Mobile.csproj --configuration Debug
dotnet build mobile\src\DEQR.Mobile\DEQR.Mobile.csproj --configuration Debug --framework net10.0-ios --runtime ios-arm64
dotnet publish mobile\src\DEQR.Mobile\DEQR.Mobile.csproj --configuration Debug --framework net10.0-ios --runtime ios-arm64 -p:BuildIpa=true
```

Observed results:

- Simulator assembly build: `PASS`, 0 warnings, 0 errors.
- `ios-arm64` assembly build: `PASS`, 0 warnings, 0 errors.
- The initial MAUI 10 build exposed obsolete `Application.MainPage` initialization and a
  missing explicit `Microsoft.Maui.Controls` reference. Both were corrected, then the
  builds passed.
- The publish command exited `0` and reported an IPA path, but no `.ipa` file existed
  anywhere under the project output afterward. Therefore **IPA artifact availability is
  NOT VERIFIED** and it must not be treated as deployable evidence.

## Physical-device status

Physical iPhone deployment, launch, camera lifecycle, QR scanning, and desktop-to-iPhone
optical reconstruction are `BLOCKED` at this observation point. No iPhone was visible over
USB and no compatible Visual Studio iOS deployment IDE was present. No physical-device
result is inferred from the passing .NET tests.

## MAUI workload installation

The initial non-elevated MAUI workload install attempts failed/stalled. The workload was later
installed outside this session and verified with `dotnet workload list`.

## Current blockers

1. **Deployable IPA: BLOCKED.** The publish command did not leave a verifiable IPA file.
2. **Visual Studio iOS deployment: BLOCKED.** No Visual Studio 2022 IDE was detected; Build
   Tools alone cannot provide the requested Local Device/Hot Restart interaction.
3. **Physical device: BLOCKED.** No Apple/iPhone USB device or Apple Mobile Device service was
   observed, so trust state, Developer Mode, signing, model, iOS version, installation, launch,
   and debugger attachment are not testable.

## Device recheck

After the device was reported as physically connected, Windows device enumeration was repeated.
No Apple/iPhone Plug and Play entry, `VID_05AC` USB interface, Apple Mobile Device service, or
Apple device CLI was visible. The connection is therefore not yet established as a trusted,
driver-recognized development device.

## Device visibility update

A later device recheck detected the physical iPhone through Windows Plug and Play. The following
interfaces reported `OK`: `Apple iPhone` (WPD), Apple Mobile Device USB Device, Apple Mobile
Device USB Composite Device, and Apple Mobile Device Ethernet. This proves USB driver visibility
only. Trust state, iPhone model, iOS version, signing/provisioning, installation, launch, and
debugger attachment remain unverified because no Apple metadata CLI or Visual Studio iOS IDE is
available on the host.
