using DEQR.Core.Container;
using DEQR.Core.PRNG;
using DEQR.Core.Protocol;

namespace DEQR.Core.Fountain;

public sealed class FountainEncoder
{
    private readonly byte[] _payload;
    private readonly ushort _blockSize;
    private readonly uint _sessionId;
    private readonly ushort _blockCount;
    private readonly byte[][] _blocks;
    private readonly RobustSoliton _soliton;
    private uint _sequenceCounter;

    public FountainEncoder(byte[] payload, ushort blockSize, uint sessionId)
    {
        ArgumentNullException.ThrowIfNull(payload);
        if (payload.Length == 0) throw new ArgumentException("Payload must not be empty", nameof(payload));
        if (payload.Length > ContainerParser.MaxFileSize) throw new ArgumentException("Payload exceeds DEQR maximum file size", nameof(payload));
        if (blockSize == 0) throw new ArgumentOutOfRangeException(nameof(blockSize));

        _payload = (byte[])payload.Clone();
        _blockSize = blockSize;
        _sessionId = sessionId;

        int k = checked((payload.Length + blockSize - 1) / blockSize);
        if (k <= 0 || k > ushort.MaxValue)
        {
            throw new ArgumentException($"Invalid block count K={k}. Must be 1-{ushort.MaxValue}.");
        }
        _blockCount = checked((ushort)k);

        _blocks = new byte[_blockCount][];
        for (int i = 0; i < _blockCount; i++)
        {
            int start = checked(i * blockSize);
            int length = Math.Min(blockSize, payload.Length - start);
            _blocks[i] = new byte[blockSize];
            Buffer.BlockCopy(payload, start, _blocks[i], 0, length);
        }

        _soliton = new RobustSoliton(_blockCount);
    }

    public ProtocolFrame NextFrame()
    {
        uint sequenceNumber = _sequenceCounter++;
        byte[] framePayload = new byte[_blockSize];

        if (sequenceNumber < _blockCount)
        {
            Buffer.BlockCopy(_blocks[checked((int)sequenceNumber)], 0, framePayload, 0, _blockSize);
        }
        else
        {
            var prng = new Mulberry32PRNG(sequenceNumber);
            int degree = _soliton.SampleDegree(prng);
            foreach (int index in SelectDistinctIndices(prng, degree, _blockCount))
            {
                byte[] block = _blocks[index];
                for (int i = 0; i < _blockSize; i++) framePayload[i] ^= block[i];
            }
        }

        return new ProtocolFrame(
            new FrameHeader(
                FrameSerializer.FrameProtocolVersion,
                _sessionId,
                0,
                sequenceNumber,
                _blockCount,
                _blockSize,
                checked((uint)_payload.Length)),
            framePayload);
    }

    public ushort GetBlockCount() => _blockCount;

    public static IReadOnlyList<int> SelectDistinctIndices(Mulberry32PRNG prng, int degree, int max)
    {
        ArgumentNullException.ThrowIfNull(prng);
        if (degree <= 0 || degree > max) throw new ArgumentOutOfRangeException(nameof(degree));
        if (max <= 0) throw new ArgumentOutOfRangeException(nameof(max));

        var indices = new List<int>(degree);
        var seen = new HashSet<int>();
        while (indices.Count < degree)
        {
            int index = prng.NextInt(0, max);
            if (seen.Add(index)) indices.Add(index);
        }
        return indices;
    }
}
