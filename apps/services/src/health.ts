import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

const noStoreHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method === "GET" && event.rawPath === "/health") {
    return {
      statusCode: 200,
      headers: noStoreHeaders,
      body: JSON.stringify({ status: "ok" }),
    };
  }

  return {
    statusCode: 404,
    headers: noStoreHeaders,
    body: JSON.stringify({ error: "not_found" }),
  };
}
