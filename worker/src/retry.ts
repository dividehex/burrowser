/** Runs `work`, retrying after `delayMs` up to `attempts` times in total; the last error is thrown. */
export async function withRetries<T>(work: () => Promise<T>, { attempts = 4, delayMs = 400 } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
