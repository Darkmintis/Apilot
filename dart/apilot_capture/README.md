# apilot_capture

> A Dio interceptor that automatically captures API traffic into Apilot's `.apilot/snapshots/` for diffing, schema inference, and contract testing — with **secrets automatically redacted**.

## Installation

```yaml
# pubspec.yaml
dependencies:
  apilot_capture:
    path: ../path/to/apilot/dart/apilot_capture
  dio: ^5.4
```

## Usage

```dart
import 'package:dio/dio.dart';
import 'package:apilot_capture/apilot_capture.dart';

final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'))
  ..interceptors.add(ApilotCaptureInterceptor());
```

That's it. Every request and response is automatically:
1. Saved as a JSON snapshot in `.apilot/snapshots/<endpointId>/`
2. Redacted for any registered secret values
3. Available for diffing via `apilot diff` or the VS Code extension

## How It Works

- **Endpoint ID**: Derived from the HTTP method + URL path (e.g. `users.get` for `GET /users/:id`).
- **Snapshots**: Written to `.apilot/snapshots/<endpoint-id>/<timestamp>.json`.
- **Secrets**: Pass a `RedactionConfig` with your secret values and they will be masked in all saved snapshots.

```dart
ApilotCaptureInterceptor(
  redaction: RedactionConfig(secrets: ['my-secret-token']),
  snapshotsDir: '/path/to/.apilot/snapshots',
)
```

## Integration with Apilot CLI

After capturing traffic with your app, run:

```sh
apilot diff users.get     # diff the last two snapshots
apilot check              # CI mode: run all + check for breaking changes
```

## License

MIT
