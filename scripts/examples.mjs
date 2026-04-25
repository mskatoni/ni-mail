const baseUrl = process.env.BASE_URL || "http://localhost:8787";
const authKey = process.env.AUTH_KEY || "replace-me";
const mailbox = process.env.MAILBOX || "hello@example.com";
const runSend = process.env.RUN_SEND === "1";
const encodedMailbox = encodeURIComponent(mailbox);

async function printResponse(title, response) {
  const body = await response.text();
  console.log(`== ${title} ==`);
  console.log(body);
  console.log();
}

async function request(path, init = {}) {
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "X-Auth-Key": authKey,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`Could not connect to ${baseUrl}. Start Wrangler dev or set BASE_URL to a deployed Worker.`, {
      cause: error,
    });
  }
}

try {
  await printResponse("health", await request("/health", { headers: {} }));
  await printResponse("list latest", await request(`/latest?mailbox=${encodeURIComponent(mailbox)}`));
  await printResponse(
    "threaded inbox",
    await request(`/api/mailboxes/${encodedMailbox}/emails?folder=inbox&threaded=true&limit=10`),
  );

  if (runSend) {
    await printResponse(
      "send",
      await request(`/api/mailboxes/${encodedMailbox}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: ["user@example.net"],
          subject: "hello from ni-mail",
          text: "test body",
        }),
      }),
    );
  } else {
    console.log("== send ==");
    console.log("skipped; set RUN_SEND=1 to exercise the optional EMAIL binding");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
