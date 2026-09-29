#!/usr/bin/env node
/**
 * Proves the flagship Dart output really compiles: renders freezed + plain
 * models into a scratch package, runs build_runner + dart analyze, and
 * decodes real JSON through them. Requires the Dart SDK and network for pub.
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaBuilder } from "../packages/core/dist/index.js";
import { render } from "../packages/codegen/dist/index.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "codegen", ".dart-check");
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "lib"), { recursive: true });
mkdirSync(join(dir, "bin"), { recursive: true });

const person = (n) => ({ id: n, name: `P${n}` });
const samples = [
  { id: 1, full_name: "Alice", active: true, email: "a@x.io", score: 1.5, role: "admin", created_at: "2024-05-01T10:00:00Z", tags: ["dev"], profile: { bio: "Hi", followers: 42 }, author: person(1), editor: person(2), teams: { "17": { name: "a" }, "42": { name: "b" } }, meta: {} },
  { id: 2, full_name: "Bob", active: false, email: null, score: 2, role: "member", created_at: "2024-05-02T11:30:00.123+05:45", tags: [], profile: { bio: "Yo", followers: 7 }, author: person(3), editor: person(4), teams: { "17": { name: "a" }, "99": { name: "c" } }, nickname: "bobby", meta: {} },
  { id: 3, full_name: "Cy", active: true, email: "c@x.io", score: 3, role: "member", created_at: "2024-05-03T09:00:00Z", tags: ["ops"], profile: { bio: "Hey", followers: 1 }, author: person(5), editor: person(6), teams: { "5": { name: "d" }, "6": { name: "e" } }, meta: {} },
  { id: 4, full_name: "Di", active: true, email: "d@x.io", score: 4, role: "admin", created_at: "2024-05-04T09:00:00Z", tags: [], profile: { bio: "Ho", followers: 3 }, author: person(7), editor: person(8), teams: { "5": { name: "d" }, "8": { name: "f" } }, meta: {} },
];
const schema = new SchemaBuilder().infer([samples]);
const spec = { id: "users.list", name: "List users", method: "GET", url: "{{baseUrl}}/teams/{{teamId}}/users", schema };

writeFileSync(join(dir, "lib", "users_list.dart"), render(spec, "dart"));
writeFileSync(join(dir, "lib", "users_list_plain.dart"), render(spec, "dart", { flavor: "plain" }));
writeFileSync(join(dir, "lib", "order_create.dart"), render({ id: "order.create", name: "Create", method: "POST", url: "https://api.x.io/orders", schema: new SchemaBuilder().infer([{ ok: true }]) }, "dart"));
writeFileSync(join(dir, "pubspec.yaml"), `name: dart_check
publish_to: none
environment:
  sdk: ^3.8.0
dependencies:
  dio: ^5.4.0
  freezed_annotation: ^3.0.0
  json_annotation: ^4.12.0
dev_dependencies:
  build_runner: ^2.4.0
  freezed: ^3.0.0
  json_serializable: ^6.8.0
`);
const withUnknownRole = [{ ...samples[0], role: "owner" }];
writeFileSync(join(dir, "bin", "main.dart"), `import 'dart:convert';
import 'package:dart_check/users_list.dart';
import 'package:dart_check/users_list_plain.dart' as plain;

void main() {
  final json = jsonDecode('${JSON.stringify(samples)}') as List<dynamic>;
  final users = json.map((e) => User.fromJson(e as Map<String, dynamic>)).toList();
  final plainUsers = json.map((e) => plain.User.fromJson(e as Map<String, dynamic>)).toList();

  assert(users[1].email == null && users[1].nickname == 'bobby' && users[0].profile.followers == 42);
  assert(users[0].role == Role.admin && users[1].role == Role.member);
  assert(users[1].createdAt.toUtc() == DateTime.utc(2024, 5, 2, 5, 45, 0, 123));
  Author sameShape = users[0].editor; // author + editor share one class
  assert(sameShape.name == 'P2' && users[0].teams['42']!.name == 'b');
  assert(plainUsers[0].fullName == 'Alice' && plainUsers[1].score == 2.0 && plainUsers[0].role == plain.Role.admin);
  assert(plainUsers[0].copyWith(fullName: 'Al').fullName == 'Al');

  final unknown = jsonDecode('${JSON.stringify(withUnknownRole)}') as List<dynamic>;
  assert(User.fromJson(unknown[0] as Map<String, dynamic>).role == Role.unknown);
  assert(plain.User.fromJson(unknown[0] as Map<String, dynamic>).role == plain.Role.unknown);

  final roundTrip = User.fromJson(jsonDecode(jsonEncode(users[0].toJson())) as Map<String, dynamic>);
  if (roundTrip != users[0]) throw StateError('freezed round trip failed');
  final plainTrip = plain.User.fromJson(jsonDecode(jsonEncode(plainUsers[1].toJson())) as Map<String, dynamic>);
  if (plainTrip.fullName != 'Bob' || plainTrip.role != plain.Role.member || plainTrip.teams['99']!.name != 'c') throw StateError('plain round trip failed');
  print('dart codegen OK: \${users.length} freezed + \${plainUsers.length} plain models decoded');
}
`);

const run = (cmd) => execSync(cmd, { cwd: dir, stdio: "inherit" });
run("dart pub get");
run("dart run build_runner build");
run("dart analyze --fatal-infos lib bin");
run("dart run --enable-asserts bin/main.dart");
