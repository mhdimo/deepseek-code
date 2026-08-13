import { getTools, toolsToAISDKFormat } from "./src/tools.js";


const mockContext = {
  workingDir: '.',
  permissions: { allowRead: true, allowWrite: true, allowExecute: true },
  abortController: new AbortController(),
  requestPermission: async () => ({ approved: true }),
  messages: [],
  lastPermissionWaitMs: 0,
  recordPermissionWait: () => {},
  consumePermissionWaitMs: () => 0,
  getTodos: () => [],
  setTodos: () => {},
  getTasks: () => [],
  setTasks: () => {},
  getPlanMode: () => false,
  setPlanMode: () => {},
};

const tools = getTools(mockContext.permissions);
console.log('Number of tools:', tools.length);

const aiSdkTools = toolsToAISDKFormat(tools, mockContext);
console.log('AI SDK tools keys:', Object.keys(aiSdkTools));


const readTool = aiSdkTools['Read'];
if (readTool) {
  console.log('\nRead tool structure:');
  console.log('- description length:', readTool.description?.length);
  console.log('- parameters type:', typeof readTool.parameters);
  console.log('- parameters keys:', Object.keys(readTool.parameters || {}));
  
  
  if (readTool.parameters && readTool.parameters.jsonSchema) {
    console.log('- parameters.jsonSchema.type:', readTool.parameters.jsonSchema.type);
    console.log('- parameters.jsonSchema.properties keys:', Object.keys(readTool.parameters.jsonSchema.properties || {}));
  }
  
  
  console.log('\nFull Read tool object (truncated):');
  const str = JSON.stringify(readTool, null, 2);
  if (str.length > 1000) {
    console.log(str.substring(0, 1000) + '...');
  } else {
    console.log(str);
  }
}


let count = 0;
for (const [name, tool] of Object.entries(aiSdkTools)) {
  if (count++ >= 2) break;
  console.log(`\nTool ${name}:`);
  console.log('  parameters._type:', tool.parameters?._type);
  console.log('  parameters.jsonSchema?.type:', tool.parameters?.jsonSchema?.type);
}