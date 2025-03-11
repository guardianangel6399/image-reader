import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

const app = express();
app.use(express.json());
app.use(cors());

// Initialize LangChain's ChatOpenAI model
const model = new ChatOpenAI({
  model: "gpt-4o",
  temperature: 0,
});

// Define whether the agent should continue or stop
function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
  const lastMessage = messages[messages.length - 1] as AIMessage;
  // No tools, so we always end after one response
  return "__end__";
}

// Call the OpenAI model
async function callModel(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

// Create and compile the workflow graph
const workflow = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue);

const langChainApp = workflow.compile();

// Express endpoint
app.post("/api/query", async (req, res) => {
  const userMessage = req.body.message;
  try {
    const result = await langChainApp.invoke({
      messages: [new HumanMessage(userMessage)],
    });

    const response = result.messages[result.messages.length - 1] as AIMessage;
    res.json({ reply: response.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
app.listen(5000, () => {
  console.log("Backend listening at http://localhost:5000");
});
