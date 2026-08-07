namespace DEQR.Core.PRNG;

/// <summary>
/// Deterministic Mulberry32 PRNG matching the TypeScript implementation.
/// All arithmetic is explicitly modulo 2^32.
/// </summary>
public sealed class Mulberry32PRNG
{
    private uint _state;

    public Mulberry32PRNG(uint seed)
    {
        _state = seed == 0 ? 0xDEADBEEFu : seed;
    }

    public uint NextUInt32()
    {
        unchecked
        {
            _state += 0x6D2B79F5u;
            uint t = _state;
            t = (t ^ (t >> 15)) * (t | 1u);
            t ^= t + ((t ^ (t >> 7)) * (t | 61u));
            return t ^ (t >> 14);
        }
    }

    /// <summary>
    /// Returns a pseudorandom double in [0.0, 1.0), exactly matching
    /// TypeScript's uint32 / 4294967296 conversion.
    /// </summary>
    public double NextDouble() => NextUInt32() / 4294967296.0;

    public int NextInt(int min, int max)
    {
        if (max <= min)
        {
            throw new ArgumentOutOfRangeException(nameof(max), "max must be greater than min");
        }
        return (int)Math.Floor(NextDouble() * (max - min) + min);
    }
}
