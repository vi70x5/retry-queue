# retry-queue

Promise-based retry queue with exponential backoff for Node.js.

## Installation

```bash
npm install retry-queue
```

## Usage

```typescript
import { RetryQueue } from 'retry-queue';

const queue = new RetryQueue({
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
});

async function fetchData(url: string) {
  return queue.add(() => fetch(url).then(r => r.json()));
}
```

## API

- `new RetryQueue(options)` — Create a queue with retry policy
- `.add(fn)` — Enqueue a function and return its result
- `.clear()` — Cancel all pending operations
- `.size` — Number of items currently in the queue

## License

MIT
