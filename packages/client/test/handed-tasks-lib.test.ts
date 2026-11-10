import { expect, test } from "bun:test";
import { handedTasksOf, tasksStartOf } from "../src/lib/issues";

const task = { issueId: "i1", number: 42, title: "Holiday campaign", agentId: "a1", channelId: "c1", rootId: "r1" };

test("the tasks a reply handed on, as its chips read them (ADR 0137 §13)", () => {
  expect(handedTasksOf({ tasks: [task] })).toEqual([{ ...task, held: false }]);
  expect(handedTasksOf({ tasks: [{ ...task, held: true }] })).toEqual([{ ...task, held: true }]);
  // Without where its conversation is, there is no chip to open.
  expect(handedTasksOf({ tasks: [{ ...task, rootId: undefined }] })).toEqual([]);
  expect(handedTasksOf({ tasks: "nope" })).toEqual([]);
  expect(handedTasksOf(null)).toEqual([]);
});

test("a reply whose tasks wait for a go shows Começar estas until someone gives it, then who did", () => {
  expect(tasksStartOf({ tasks: [task] })).toBeNull();
  expect(tasksStartOf({ tasks: [{ ...task, held: true }] })).toEqual({ state: "waiting" });
  expect(tasksStartOf({ tasks: [{ ...task, held: true }], tasksStarted: { byUserId: "u1", at: "x" } })).toEqual({
    state: "started",
    by: "u1",
  });
  expect(tasksStartOf(null)).toBeNull();
});
