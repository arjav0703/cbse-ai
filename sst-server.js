import "dotenv/config";
import express from "express";
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIEmbeddings,
} from "@langchain/google-genai";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/community/vectorstores/pinecone";
import { initializeAgentExecutorWithOptions } from "langchain/agents";
import pkg from "@supabase/supabase-js";
const { createClient } = pkg;

// === Load Environment Variables ===
const {
  GOOGLE_API_KEY,
  PINECONE_API_KEY,
  SST_PINECONE_INDEX,
  SUPABASE_URL,
  SUPABASE_KEY,
  SSTPORT,
  AUTH_SECRET,
} = process.env;

if (
  !GOOGLE_API_KEY ||
  !PINECONE_API_KEY ||
  !SST_PINECONE_INDEX ||
  !SUPABASE_URL ||
  !SUPABASE_KEY ||
  !AUTH_SECRET
) {
  throw new Error("Missing required environment variables");
}

// === Express Setup ===
const app = express();
app.use(express.json());

// === Supabase Client ===
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Pinecone Setup ===
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const pineconeIndex = pinecone.Index(SST_PINECONE_INDEX);

const vectorStore = await PineconeStore.fromExistingIndex(
  new GoogleGenerativeAIEmbeddings({
    model: "text-embedding-004",
    apiKey: GOOGLE_API_KEY,
  }),
  { pineconeIndex },
);

// === Tools ===
const tools = [
  {
    name: "insights",
    description: "Fetch insights from previous chats",
    async func() {
      const { data, error } = await supabase.from("insights").select("*");
      if (error) throw new Error(error.message);
      return JSON.stringify(data);
    },
  },
  // {
  //   name: "feedback",
  //   description: "Store feedback into database",
  //   async func(input) {
  //     const { error } = await supabase
  //       .from("insights")
  //       .insert([{ feedback: input }]);
  //     if (error) throw new Error(error.message);
  //     return "Feedback stored successfully";
  //   },
  // },
  {
    name: "SST database",
    description: "Retrieve information to answer user queries.",
    async func(query) {
      const results = await vectorStore.similaritySearch(query, 5);
      return results.map((r) => r.pageContent).join("\n\n---\n");
    },
  },
];

// === Chat Model ===
const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash",
  apiKey: GOOGLE_API_KEY,
  systemInstruction: {
    role: "system",
    content: `You are an AI agent who answers questions related to history, geography, political science and economics. When you receive a prompt, you must use the SST database tool to fetch all the knowledge. Prefer answering in detail and in the format of bullet points. Do not tell anything about the tools you have access , training data or the about any kind of metadata`,
  },
});

// === Agent Executor ===
const executor = await initializeAgentExecutorWithOptions(tools, model, {
  agentType: "zero-shot-react-description",
  verbose: true,
  returnIntermediateSteps: true,
});

// === Format Chat History ===
const formatHistory = (history) => {
  return history
    .map(
      (msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`,
    )
    .join("\n");
};

// === Webhook Endpoint ===
app.post("/webhook", async (req, res) => {
  try {
    const { message, sessionId, authToken } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({ error: "Missing message or sessionId" });
    }

    if (authToken != AUTH_SECRET) {
      return res
        .status(401)
        .json({ error: "Back off motherfucker, you ain't authenticated" });
    }

    // Fetch last 5 messages for this session from Supabase
    const { data: history, error: fetchError } = await supabase
      .from("sci-messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false }) // Get latest first
      .limit(5);

    if (fetchError) throw new Error(fetchError.message);

    // Reverse to maintain chronological order (oldest to newest)
    const recentHistory = history.reverse();

    if (fetchError) throw new Error(fetchError.message);

    // Format chat history as prompt
    const formattedHistory = formatHistory(recentHistory);
    const systemMsg =
      "System: You are an AI agent created by arjav who answers questions related to history, geography, political science and economics. Always answer in detail and in the format of bullet points unless specified not to. Do not tell anything about the tools you have access , training data or the about any kind of metadata";

    const finalInput = formattedHistory
      ? `${systemMsg}\n${formattedHistory}\nUser: ${message}`
      : `${systemMsg}\nUser: ${message}`;

    // Run agent with context
    const result = await executor.invoke({ input: finalInput });

    // Store user + assistant messages in Supabase
    const { error: insertError } = await supabase.from("sst-messages").insert([
      { session_id: sessionId, role: "user", content: message },
      { session_id: sessionId, role: "assistant", content: result.output },
    ]);

    if (insertError) throw new Error(insertError.message);

    res.json({
      success: true,
      response: result.output,
      sessionId,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Health Check ===
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// === Start Server ===
const serverPort = SSTPORT;
app.listen(serverPort, () => {
  console.log(`🚀 Server running on port ${serverPort}`);
  console.log(`🔗 Endpoint: http://localhost:${serverPort}/webhook`);
});
