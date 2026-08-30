/**
 * Agent Identity Context
 *
 * Builds trusted identity information for protected Agent actions.
 *
 * IMPORTANT:
 * - userId must come from authenticated server context.
 * - role and workspaceId must come from trusted server-side storage.
 * - Never trust role/workspaceId supplied directly by the client.
 */

export type AgentRole =
  | "ORCHESTRATOR"
  | "PLANNER"
  | "EXECUTOR"
  | "REVIEWER";

/**
 * Trusted identity passed to authorization middleware.
 */
export interface AgentIdentity {
  /**
   * Authenticated user that initiated the request.
   */
  userId: string;

  /**
   * Agent performing the action.
   */
  agentId: string;

  /**
   * Trusted Agent role.
   */
  role: AgentRole;

  /**
   * Workspace assigned to this Agent.
   */
  workspaceId: string;

  /**
   * Current execution/run identifier.
   */
  runId: string;
}


/**
 * Minimal trusted Agent information stored by backend.
 */
export interface StoredAgentIdentity {
  agentId: string;

  /**
   * User that owns / controls this Agent.
   */
  userId: string;

  role: AgentRole;

  workspaceId: string;
}


/**
 * Backend dependencies required to resolve identity.
 */
export interface AgentIdentityDependencies {

  /**
   * Load Agent information from trusted backend storage.
   *
   * This could later call:
   *
   * store.getAgent(...)
   * agentService.getAgent(...)
   * database query
   */
  loadAgentIdentity(
    agentId: string
  ): Promise<StoredAgentIdentity | null>;
}


/**
 * Raised when identity cannot be verified.
 */
export class AgentIdentityError extends Error {

  public readonly statusCode = 403;

  constructor(message: string) {

    super(message);

    this.name = "AgentIdentityError";
  }
}


/**
 * Build the trusted identity context that will be passed
 * to authorization middleware.
 *
 * authenticatedUserId:
 *   Must come from trusted authentication middleware/session.
 *
 * agentId:
 *   Agent being executed.
 *
 * runId:
 *   Current Agent execution ID.
 */
export async function resolveAgentIdentity(
  authenticatedUserId: string,
  agentId: string,
  runId: string,
  deps: AgentIdentityDependencies
): Promise<AgentIdentity> {

  /*
   * Basic validation.
   */
  if (!authenticatedUserId) {

    throw new AgentIdentityError(
      "Authenticated user ID is required."
    );
  }


  if (!agentId) {

    throw new AgentIdentityError(
      "Agent ID is required."
    );
  }


  if (!runId) {

    throw new AgentIdentityError(
      "Run ID is required."
    );
  }


  /*
   * Load trusted Agent information from backend storage.
   *
   * Do NOT trust:
   *
   * request.body.role
   * request.body.workspaceId
   */
  const storedAgent =
    await deps.loadAgentIdentity(
      agentId
    );


  if (!storedAgent) {

    throw new AgentIdentityError(
      `Agent '${agentId}' does not exist.`
    );
  }


  /*
   * Verify that the authenticated user is actually
   * allowed to act through this Agent.
   */
  if (
    storedAgent.userId !==
    authenticatedUserId
  ) {

    throw new AgentIdentityError(
      "Authenticated user does not own or control this Agent."
    );
  }


  /*
   * Construct trusted identity.
   */
  return {

    userId:
      authenticatedUserId,

    agentId:
      storedAgent.agentId,

    role:
      storedAgent.role,

    workspaceId:
      storedAgent.workspaceId,

    runId,
  };
}