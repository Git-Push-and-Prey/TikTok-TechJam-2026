import { describe, expect, it } from "vitest";
import {
  ExecutionGuardrail,
  GuardrailLimitError,
} from "./execution-guardrail";

describe("ExecutionGuardrail", () => {
  it("allows execution while under the step limit", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 3,
      timeoutMs: 60_000,
    });

    const first = guardrail.check();
    const second = guardrail.check();

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(guardrail.getStepsUsed()).toBe(2);
  });

  it("blocks execution when the step limit is reached", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 2,
      timeoutMs: 60_000,
    });

    guardrail.check();
    guardrail.check();

    const third = guardrail.check();

    expect(third).toEqual({
      allowed: false,
      reason: "Maximum execution steps exceeded",
      limit: 2,
      used: 2,
    });
  });

  it("does not increase the step count after blocking", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 2,
      timeoutMs: 60_000,
    });

    guardrail.check();
    guardrail.check();

    const third = guardrail.check();
    const fourth = guardrail.check();

    expect(third.allowed).toBe(false);
    expect(fourth.allowed).toBe(false);
    expect(guardrail.getStepsUsed()).toBe(2);
  });

  it("rejects an invalid step limit", () => {
    expect(
      () =>
        new ExecutionGuardrail({
          maxSteps: 0,
          timeoutMs: 60_000,
        }),
    ).toThrow("maxSteps must be a positive integer");
  });

  it("rejects an invalid timeout", () => {
    expect(
      () =>
        new ExecutionGuardrail({
          maxSteps: 10,
          timeoutMs: 0,
        }),
    ).toThrow("timeoutMs must be a positive integer");
  });

  it("can reset the step counter", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 2,
      timeoutMs: 60_000,
    });

    guardrail.check();
    guardrail.check();

    expect(guardrail.getStepsUsed()).toBe(2);

    guardrail.reset();

    expect(guardrail.getStepsUsed()).toBe(0);
    expect(guardrail.check().allowed).toBe(true);
  });

  it("consume allows a step under the limit", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 2,
      timeoutMs: 60_000,
    });

    expect(() => guardrail.consume()).not.toThrow();
    expect(guardrail.getStepsUsed()).toBe(1);
  });

  it("consume throws when the limit is exceeded", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 1,
      timeoutMs: 60_000,
    });

    guardrail.consume();

    expect(() => guardrail.consume()).toThrow(GuardrailLimitError);
    expect(() => guardrail.consume()).toThrow(
      "Maximum execution steps exceeded",
    );
  });

  it("reports remaining steps", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 5,
      timeoutMs: 60_000,
    });

    expect(guardrail.getRemainingSteps()).toBe(5);

    guardrail.consume();

    expect(guardrail.getRemainingSteps()).toBe(4);
  });

  it("reports the configured timeout", () => {
    const guardrail = new ExecutionGuardrail({
      maxSteps: 10,
      timeoutMs: 5_000,
    });

    expect(guardrail.getTimeoutMs()).toBe(5_000);
  });
});