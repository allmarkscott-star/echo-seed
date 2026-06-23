export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

function sanitizeMessages(messages) {
  return messages.map(function(msg) {
    if (!Array.isArray(msg.content)) return msg;
    var cleanContent = msg.content.map(function(block) {
      if (block.type === 'document') {
        var mediaType = block.source && block.source.media_type;
        if (mediaType !== 'application/pdf') {
          return { type: 'text', text: '[File attachment]' };
        }
      }
      return block;
    });
    return Object.assign({}, msg, { content: cleanContent });
  });
}

function extractError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error && err.error.message) return err.error.message;
  if (err.error && typeof err.error === 'string') return err.error;
  return JSON.stringify(err);
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Calls the Anthropic API and retries only on 529 (overloaded_error).
// Other error statuses (400, 401, 404, etc.) are real problems and
// are returned immediately rather than retried.
async function callAnthropicWithRetry(requestBody, maxRetries) {
  var attempt = 0;

  while (true) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    if (response.status !== 529 || attempt >= maxRetries) {
      return response;
    }

    // Exponential backoff with a little jitter: ~1s, ~2s, ~4s...
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 8000);
    const jitter = Math.random() * 250;
    await sleep(baseDelay + jitter);

    attempt += 1;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, systemPrompt, model } = req.body;
  const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7'];
  const useModel = ALLOWED_MODELS.indexOf(model) !== -1 ? model : 'claude-sonnet-4-6';

  try {
    const response = await callAnthropicWithRetry({
      model: useModel,
      max_tokens: 1500,
      system: systemPrompt,
      messages: sanitizeMessages(messages),
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ]
    }, 3); // up to 3 retries (~4 attempts total), keep this low on serverless

    const data = await response.json();

    if (!response.ok) {
      // If we're still overloaded after retries, send a clearer message
      // than the raw Anthropic error so the frontend can show something
      // more useful than a generic failure.
      if (response.status === 529) {
        return res.status(529).json({
          error: 'Claude is temporarily overloaded. Please try again in a moment.'
        });
      }
      return res.status(response.status).json({ error: extractError(data.error || data) });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: extractError(error) });
  }
}
