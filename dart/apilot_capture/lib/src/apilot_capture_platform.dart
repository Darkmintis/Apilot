/// Apilot Traffic Capture Plugin
///
/// A Dio interceptor that captures API request/response pairs into
/// `.apilot/snapshots/` for the Apilot extension and CLI to pick up.
/// Secrets are redacted automatically.
library apilot_capture;

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:path/path.dart' as p;

export 'src/apilot_capture_platform.dart';

/// Configuration for redacting secrets from captured snapshots.
class RedactionConfig {
  /// List of secret string values to mask from all captured data.
  final List<String> secrets;

  /// Directory where snapshots are stored.
  /// Defaults to `.apilot/snapshots` relative to the working directory.
  final String? snapshotsDir;

  /// Optional project root for relative path resolution.
  final String? projectRoot;

  RedactionConfig({
    this.secrets = const [],
    this.snapshotsDir,
    this.projectRoot,
  });

  String get snapshotsPath {
    if (snapshotsDir != null) {
      return snapshotsDir!;
    }
    final root = projectRoot ?? Directory.current.path;
    return p.join(root, '.apilot', 'snapshots');
  }
}

/// Dio interceptor that captures traffic into Apilot snapshots.
class ApilotCaptureInterceptor extends Interceptor {
  final RedactionConfig redaction;

  ApilotCaptureInterceptor({RedactionConfig? redaction})
      : redaction = redaction ?? RedactionConfig() {
    _ensureSnapshotsDir();
  }

  void _ensureSnapshotsDir() {
    final dir = Directory(redaction.snapshotsPath);
    if (!dir.existsSync()) {
      dir.createSync(recursive: true);
    }
  }

  /// Derive an endpoint ID from method + URL path.
  /// e.g. GET /users/123 → "users.get"
  String _endpointId(RequestOptions options) {
    final method = options.method.toLowerCase();
    final pathSegments = options.path.split('/').where((s) => s.isNotEmpty).toList();

    // Remove numeric IDs and replace with the resource name
    // e.g. ["users", "123"] → "users"
    String resource = 'root';
    if (pathSegments.isNotEmpty) {
      // Find the first non-numeric segment as the resource
      for (final seg in pathSegments) {
        final isNumeric = double.tryParse(seg) != null;
        if (!isNumeric) {
          resource = seg;
          break;
        }
      }
    }

    // Use the last path param (e.g., "users/:id" → "users.get")
    // But for nested paths like "users/:id/posts" → "users.posts.get"
    final parts = <String>[];
    for (var i = 0; i < pathSegments.length; i++) {
      final seg = pathSegments[i];
      final isNumeric = double.tryParse(seg) != null;
      if (!isNumeric) {
        parts.add(seg.replaceAll('-', '_').replaceAll('.','_'));
      }
    }

    if (parts.isEmpty) return '${resource}.${method}';
    return '${parts.join('.')}.${method}';
  }

  /// Redact secret values from a string.
  String _redactString(String input) {
    String result = input;
    for (final secret in redaction.secrets) {
      if (secret.isNotEmpty) {
        result = result.replaceAll(secret, '***REDACTED***');
      }
    }
    return result;
  }

  /// Recursively redact secrets from a JSON-compatible value.
  dynamic _redactValue(dynamic value) {
    if (value is String) {
      return _redactString(value);
    }
    if (value is Map) {
      return Map.fromEntries(
        value.entries.map((e) => MapEntry(e.key, _redactValue(e.value))),
      );
    }
    if (value is List) {
      return value.map(_redactValue).toList();
    }
    return value;
  }

  /// Redact headers (case-insensitive matching for common auth headers).
  Map<String, dynamic> _redactHeaders(Map<String, dynamic> headers) {
    final result = <String, dynamic>{};
    for (final entry in headers.entries) {
      final key = entry.key.toLowerCase();
      final value = entry.value.toString();
      if (key == 'authorization' || key == 'cookie' || key == 'set-cookie') {
        result[entry.key] = _redactString(value);
      } else {
        result[entry.key] = _redactString(value);
      }
    }
    return result;
  }

  @override
  void onResponse(Response response, RequestInterceptorHandler handler) {
    try {
      _saveSnapshot(response);
    } catch (e, st) {
      // Silently fail — don't break the app's request flow
      stderr.writeln('[apilot_capture] Failed to save snapshot: $e');
    }
    super.onResponse(response, handler);
  }

  @override
  void onError(DioException err, RequestInterceptorHandler handler) {
    try {
      if (err.response != null) {
        _saveSnapshot(err.response!, error: err);
      }
    } catch (e) {
      stderr.writeln('[apilot_capture] Failed to save error snapshot: $e');
    }
    super.onError(err, handler);
  }

  void _saveSnapshot(Response response, {DioException? error}) {
    final options = response.requestOptions;
    final endpointId = _endpointId(options);
    final timestamp = DateTime.now().toUtc().toIso8601String();

    final bodyRaw = response.data is String
        ? response.data as String
        : jsonEncode(response.data);

    final bodyJson = response.data is Map || response.data is List
        ? response.data
        : bodyRaw;

    final snapshot = {
      'id': '$endpointId-${DateTime.now().millisecondsSinceEpoch}',
      'endpointId': endpointId,
      'timestamp': timestamp,
      'request': {
        'method': options.method,
        'url': _redactString(options.uri.toString()),
        'headers': _redactHeaders(
          (options.headers ?? {}).map((k, v) => MapEntry(k, v is List ? v.join(', ') : v?.toString() ?? '')),
        ),
        'body': options.data != null ? _redactString(options.data.toString()) : null,
      },
      'status': response.statusCode ?? 0,
      'headers': _redactHeaders(
        response.headers.map((k, v) => MapEntry(k, v.join(', '))),
      ),
      'body': _redactValue(bodyJson) as dynamic,
      'bodyRaw': _redactString(bodyRaw),
      'timeMs': response.requestOptions.sendTimeout,
      'size': bodyRaw.length,
      'passed': (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 400,
      'failures': error != null
          ? [{'message': _redactString(error.toString()), 'status': response.statusCode}]
          : [],
    };

    final dir = Directory(redaction.snapshotsPath);
    if (!dir.existsSync()) {
      dir.createSync(recursive: true);
    }

    final endpointDir = Directory(p.join(dir.path, endpointId));
    if (!endpointDir.existsSync()) {
      endpointDir.createSync(recursive: true);
    }

    final fileName = '${snapshot['id']!.toString()}.json';
    final file = File(p.join(endpointDir.path, fileName));
    file.writeAsStringSync(jsonEncode(snapshot));
  }
}
