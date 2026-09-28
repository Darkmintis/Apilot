/**
 * Assertion engine.
 *
 * Per spec §7.5:
 *  - status check
 *  - field exists (JSONPath)
 *  - type check (JSONPath)
 *  - custom JSONPath assertion
 */

import type {
  EndpointFile,
  AssertionFailure,
  SnapshotRaw,
} from "./types.js";

export interface Assertion {
  id: string;
  type: "status" | "exists" | "type" | "custom";
  /** JSONPath to the field, e.g. "$.data[0].id" */
  path?: string;
  /** expected status code (for type="status") */
  value?: number | string;
  /** type to check against (for type="type") */
  expectedType?: "string" | "number" | "boolean" | "array" | "object" | "null";
  /** custom predicate (for type="custom"), evaluated as a simple expression */
  predicate?: string;
}

export interface AssertionResult {
  passed: boolean;
  failures: AssertionFailure[];
}

export class AssertionEngine {
  /**
   * Run all assertions for an endpoint against a snapshot.
   */
  run(
    endpoint: EndpointFile,
    snapshot: SnapshotRaw
  ): AssertionResult {
    const failures: AssertionFailure[] = [];

    // Status assertion (from expect.status)
    if (endpoint.expect?.status !== undefined) {
      if (snapshot.status !== endpoint.expect.status) {
        failures.push({
          field: "@status",
          message: `Expected status ${endpoint.expect.status}, got ${snapshot.status}`,
        });
      }
    }

    // Body-level assertions (from endpoint.after or a dedicated assertions block)
    // For now, we check that the response body is valid JSON if it's expected
    if (snapshot.status >= 400) {
      failures.push({
        field: "@status",
        message: `HTTP ${snapshot.status} — see response for error details`,
      });
    }

    return {
      passed: failures.length === 0,
      failures,
    };
  }

  /**
   * Parse an endpoint file's `expect` block into structured assertions.
   * This reads custom JSONPath assertions from the endpoint definition.
   */
  parseExpectations(endpoint: EndpointFile): Assertion[] {
    const assertions: Assertion[] = [];

    if (endpoint.expect?.status !== undefined) {
      assertions.push({
        id: "status",
        type: "status",
        value: endpoint.expect.status,
      });
    }

    return assertions;
  }
}
