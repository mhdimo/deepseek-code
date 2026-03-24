#pragma once

#include "../core/types.hpp"
#include <vector>
#include <functional>

namespace zcode::agent {

using EventCallback = std::function<void(const zcode::core::AgentEvent&)>;

/**
 * Agent - Orchestrates multi-step agentic loop with tool calling
 * 
 * Implements:
 * 1. Call model with tools
 * 2. Stream text-delta and tool events
 * 3. After stream ends, check for tool calls
 * 4. If yes, add tool call/result messages and loop
 * 5. Continue until no tool calls or maxSteps reached
 */
class Agent {
public:
    Agent(
        const zcode::core::AgentConfig& config,
        const zcode::core::ProviderConfig& providerConfig
    );

    ~Agent();

    // Getters
    zcode::core::AgentName getName() const { return config.name; }
    std::string getDisplayName() const { return config.displayName; }
    std::string getDescription() const { return config.description; }
    zcode::core::PermissionRuleset getPermissions() const { return config.permissions; }

    /**
     * Run the agent with a user message and history
     * Yields AgentEvent objects via callback
     */
    void run(
        const std::string& userMessage,
        const std::vector<zcode::core::Message>& history,
        const std::string& workingDir,
        EventCallback onEvent
    );

    /**
     * Abort the current generation
     */
    void abort();

private:
    zcode::core::AgentConfig config;
    zcode::core::ProviderConfig providerConfig;
    bool aborted = false;

    void executeStep(
        const std::vector<zcode::core::Message>& messages,
        const std::string& workingDir,
        EventCallback onEvent
    );
};

} // namespace zcode::agent
