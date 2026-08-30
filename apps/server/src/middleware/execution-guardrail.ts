export interface ExecutionGuardrailConfig {
    maxSteps: number;
    timeoutMs: number;
  }
  
  export type GuardrailDecision =
    | {
        allowed: true;
        remainingSteps: number;
      }
    | {
        allowed: false;
        reason: string;
        limit: number;
        used: number;
      };
  
  export class GuardrailLimitError extends Error {
    readonly limit: number;
    readonly used: number;
  
    constructor(limit: number, used: number) {
      super("Maximum execution steps exceeded");
      this.name = "GuardrailLimitError";
      this.limit = limit;
      this.used = used;
    }
  }
  
  export class ExecutionTimeoutError extends Error {
    readonly timeoutMs: number;
  
    constructor(timeoutMs: number) {
      super("Execution timeout exceeded");
      this.name = "ExecutionTimeoutError";
      this.timeoutMs = timeoutMs;
    }
  }
  
  export class ExecutionGuardrail {
    private readonly maxSteps: number;
    private readonly timeoutMs: number;
    private stepsUsed = 0;
  
    constructor(config: ExecutionGuardrailConfig) {
      if (!Number.isInteger(config.maxSteps) || config.maxSteps <= 0) {
        throw new Error("maxSteps must be a positive integer");
      }
  
      if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive integer");
      }
  
      this.maxSteps = config.maxSteps;
      this.timeoutMs = config.timeoutMs;
    }
  
    check(): GuardrailDecision {
      if (this.stepsUsed >= this.maxSteps) {
        return {
          allowed: false,
          reason: "Maximum execution steps exceeded",
          limit: this.maxSteps,
          used: this.stepsUsed,
        };
      }
  
      this.stepsUsed += 1;
  
      return {
        allowed: true,
        remainingSteps: this.maxSteps - this.stepsUsed,
      };
    }
  
    consume(): void {
      const decision = this.check();
  
      if (!decision.allowed) {
        throw new GuardrailLimitError(
          decision.limit,
          decision.used,
        );
      }
    }
  
    getStepsUsed(): number {
      return this.stepsUsed;
    }
  
    getMaxSteps(): number {
      return this.maxSteps;
    }
  
    getRemainingSteps(): number {
      return this.maxSteps - this.stepsUsed;
    }
  
    getTimeoutMs(): number {
      return this.timeoutMs;
    }
  
    createTimeout(onTimeout: () => void): NodeJS.Timeout {
      const timer = setTimeout(() => {
        onTimeout();
      }, this.timeoutMs);
  
      timer.unref();
  
      return timer;
    }
  
    reset(): void {
      this.stepsUsed = 0;
    }
  }