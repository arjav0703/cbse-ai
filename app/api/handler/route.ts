import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  console.log("Handler: request received");

  try {
    const body = await request.json();
    console.log("Handler: Request body:", body);

    // only vreated if !present
    const sessionId =
      body.sessionId ||
      `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // request data
    const reqData = {
      message: body.message,
      sessionId: sessionId,
      subject: body.subject,
      longans: body.longans,
      userid: body.userid,
      authToken: process.env.AUTH_SECRET,
    };

    const reqURL = await body.reqUrl;

    console.log("Handler: Sending request to => ", reqURL);
    console.log("Handler: Request data => ", reqData);

    const response = await fetch(reqURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(reqData),
    });

    console.log("Handler: Response status => ", response.status);

    // Handle response more robustly
    let responseData: any = {};
    let rawResponse = "";

    try {
      // First try to read as stream
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          if (value) {
            rawResponse += decoder.decode(value, { stream: !done });
          }
        }
      } else {
        // Fallback to regular text() if no stream
        rawResponse = await response.text();
      }

      // Trim whitespace which might cause issues
      rawResponse = rawResponse.trim();

      console.log("Handler: Raw response length:", rawResponse.length);

      // Only try to parse if there's actual content
      if (rawResponse) {
        try {
          responseData = JSON.parse(rawResponse);
        } catch (parseError) {
          console.warn(
            "Handler: Failed to parse as JSON, treating as text:",
            parseError,
          );
          responseData = { message: rawResponse };
        }
      } else {
        responseData = {};
      }
    } catch (e) {
      console.error("Handler: Error handling response:", e);
      responseData = { error: "Handler: Failed to process response" };
    }

    // Process the response data
    let finalResponse = "";

    if (Array.isArray(responseData) && responseData.length > 0) {
      finalResponse = responseData[0].output || "";
    } else if (typeof responseData === "object" && responseData !== null) {
      finalResponse =
        responseData.output ||
        responseData.response ||
        responseData.message ||
        responseData.text ||
        responseData.content ||
        JSON.stringify(responseData);
    } else {
      finalResponse = String(responseData);
    }

    return NextResponse.json({
      success: true,
      response: finalResponse,
      sessionId: sessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Handler error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Handler: Failed to send request",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
