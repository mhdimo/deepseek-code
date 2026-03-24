#pragma once

#include "../core/types.hpp"
#include <string>
#include <vector>

namespace zcode::tool {

/**
 * Tool Factory
 * Creates permission-gated tools for file operations, execution, and search
 */
class ToolFactory {
public:
    /**
     * Create all available tools
     */
    static std::vector<std::string> getAvailableTools(
        const zcode::core::PermissionRuleset& permissions
    );

    /**
     * Execute a tool by name
     */
    static zcode::core::ToolResult executeTool(
        const std::string& toolName,
        const std::string& workingDir,
        const std::vector<std::pair<std::string, std::string>>& args
    );
};

// ─── File Tools ─────────────────────────────────────────────────────────────

namespace file {
    zcode::core::ToolResult read(
        const std::string& filePath,
        const std::string& workingDir
    );

    zcode::core::ToolResult write(
        const std::string& filePath,
        const std::string& content,
        const std::string& workingDir
    );

    zcode::core::ToolResult edit(
        const std::string& filePath,
        const std::string& oldText,
        const std::string& newText,
        const std::string& workingDir
    );
}

// ─── Execution Tools ────────────────────────────────────────────────────────

namespace exec {
    zcode::core::ToolResult bash(
        const std::string& command,
        const std::string& workingDir
    );
}

// ─── Search Tools ───────────────────────────────────────────────────────────

namespace search {
    zcode::core::ToolResult glob(
        const std::string& pattern,
        const std::string& workingDir
    );

    zcode::core::ToolResult grep(
        const std::string& pattern,
        const std::string& filePath,
        const std::string& workingDir
    );

    zcode::core::ToolResult listDirectory(
        const std::string& dirPath,
        const std::string& workingDir
    );
}

} // namespace zcode::tool
