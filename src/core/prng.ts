/**
 * Deterministic PRNG for Fountain Coding
 *
 * Mulberry32 implementation. Fast and provides good enough
 * distribution for selecting LT block combinations.
 */
export class PRNG {
  private state: number;

  constructor(seed: number) {
    // Prevent 0 seed, though mulberry32 handles it reasonably well
    this.state = seed === 0 ? 0xdeadbeef : seed >>> 0;
  }

  /**
   * Returns a pseudorandom number between 0 and 1.
   */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a random integer in the range [min, max).
   */
  public nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min) + min);
  }
}

/**
 * Robust Soliton Distribution sampler for LT codes.
 */
export class RobustSoliton {
  private c: number;
  private delta: number;
  private K: number;
  private probabilities: number[];
  private cdf: number[];

  /**
   * @param K Number of source blocks
   * @param c Tuning parameter (typically 0.1 - 0.2)
   * @param delta Failure probability (typically 0.05)
   */
  constructor(K: number, c = 0.1, delta = 0.05) {
    this.K = K;
    this.c = c;
    this.delta = delta;
    this.probabilities = new Array(K + 1).fill(0);
    this.cdf = new Array(K + 1).fill(0);

    this.initDistribution();
  }

  private initDistribution() {
    const K = this.K;
    const S = this.c * Math.log(K / this.delta) * Math.sqrt(K);
    
    // Ideal soliton distribution rho(d)
    const rho = new Array(K + 1).fill(0);
    rho[1] = 1 / K;
    for (let d = 2; d <= K; d++) {
      rho[d] = 1 / (d * (d - 1));
    }

    // Robust soliton distribution tau(d)
    const tau = new Array(K + 1).fill(0);
    const limit = Math.floor(K / S);
    
    for (let d = 1; d <= limit - 1; d++) {
      tau[d] = S / (K * d);
    }
    tau[limit] = (S * Math.log(S / this.delta)) / K;
    // tau[d] is 0 for d > K/S

    // Combine and normalize
    let sum = 0;
    for (let d = 1; d <= K; d++) {
      this.probabilities[d] = rho[d] + tau[d];
      sum += this.probabilities[d];
    }

    // Create CDF
    let cumulative = 0;
    for (let d = 1; d <= K; d++) {
      this.probabilities[d] /= sum; // normalize
      cumulative += this.probabilities[d];
      this.cdf[d] = cumulative;
    }
  }

  /**
   * Sample a degree d from the distribution using the given PRNG.
   */
  public sampleDegree(prng: PRNG): number {
    const p = prng.next();
    
    // Binary search through CDF
    let low = 1;
    let high = this.K;
    
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (p <= this.cdf[mid]) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }
}
