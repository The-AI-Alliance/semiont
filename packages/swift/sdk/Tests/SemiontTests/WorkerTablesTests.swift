import Testing

@testable import Semiont

@Test func workerJobFiltersRunTheSharedCases() throws {
  let table = try Spec.read("jobs/filter-cases.json").object
  for value in try required(table, "cases").array {
    let row = try value.object
    let matches = try jobMatchesFilter(required(row, "filter"), job: required(row, "job"))
    #expect(JSONValue.bool(matches) == (try required(row, "matches")))
  }
}

@Test func workerJobRetriesRunTheSharedCases() throws {
  let table = try Spec.read("jobs/retry-cases.json").object
  for value in try required(table, "cases").array {
    let row = try value.object
    let retries = try willRetryAfter(
      retryCount: decoded(Int.self, required(row, "retryCount")),
      maxRetries: decoded(Int.self, required(row, "maxRetries")),
      failureClass: row["failureClass"].map { try decoded(FailureClass.self, $0) })
    #expect(JSONValue.bool(retries) == (try required(row, "retries")))
  }
}
