using DEQR.Core.Container;
using DEQR.Core.PRNG;
using DEQR.Core.Protocol;

namespace DEQR.Core.Fountain;

internal sealed class DecoderNode
{
    public required uint SequenceNumber { get; init; }
    public required List<int> Neighbors { get; set; }
    public required byte[] Payload { get; init; }
    public int Degree => Neighbors.Count;
}

public sealed class FountainDecoder
{
    private long _sessionId = -1;
    private int _blockCount = -1;
    private int _blockSize = -1;
    private int _totalPayloadLength = -1;
    private RobustSoliton? _soliton;

    private readonly Dictionary<uint, DecoderNode> _frames = new();
    private readonly HashSet<uint> _seenSequences = new();
    private byte[]?[] _decodedBlocks = Array.Empty<byte[]?>();
    private int _solvedCount;
    private bool _isComplete;

    public bool IsComplete => _isComplete;
    public int SolvedCount => _solvedCount;
    public int BlockCount => _blockCount;

    public bool ReceiveFrame(ProtocolFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);
        if (_isComplete) return true;

        FrameHeader header = frame.Header;
        byte[] payload = frame.Payload;
        ValidateFrameShape(header, payload);

        if (!_seenSequences.Add(header.SequenceNumber))
        {
            return false;
        }

        if (_sessionId == -1)
        {
            Initialize(header);
        }
        else if (_sessionId != header.SessionId ||
                 _blockCount != header.BlockCount ||
                 _blockSize != header.BlockSize ||
                 _totalPayloadLength != header.TotalPayloadLength)
        {
            throw new InvalidDataException("Inconsistent frame metadata received for current session");
        }

        List<int> neighbors;
        if (header.SequenceNumber < _blockCount)
        {
            neighbors = new List<int> { checked((int)header.SequenceNumber) };
        }
        else
        {
            var prng = new Mulberry32PRNG(header.SequenceNumber);
            int degree = _soliton!.SampleDegree(prng);
            neighbors = FountainEncoder.SelectDistinctIndices(prng, degree, _blockCount).ToList();
        }

        var node = new DecoderNode
        {
            SequenceNumber = header.SequenceNumber,
            Neighbors = neighbors,
            Payload = (byte[])payload.Clone()
        };

        EliminateSolvedBlocks(node);
        if (node.Degree == 0) return false;

        _frames[header.SequenceNumber] = node;
        if (node.Degree == 1) ProcessRipple(node);
        return _isComplete;
    }

    public byte[] ReconstructPayload()
    {
        if (!_isComplete)
        {
            throw new InvalidOperationException($"Cannot reconstruct payload: missing {_blockCount - _solvedCount} blocks");
        }

        byte[] fullBuffer = new byte[checked(_blockCount * _blockSize)];
        for (int i = 0; i < _blockCount; i++)
        {
            byte[] block = _decodedBlocks[i] ?? throw new InvalidOperationException($"Decoded block {i} is unexpectedly missing");
            Buffer.BlockCopy(block, 0, fullBuffer, checked(i * _blockSize), _blockSize);
        }

        byte[] result = new byte[_totalPayloadLength];
        Buffer.BlockCopy(fullBuffer, 0, result, 0, _totalPayloadLength);
        return result;
    }

    public double GetProgress() => _blockCount <= 0 ? 0 : (double)_solvedCount / _blockCount;

    private void Initialize(FrameHeader header)
    {
        _sessionId = header.SessionId;
        _blockCount = header.BlockCount;
        _blockSize = header.BlockSize;
        _totalPayloadLength = checked((int)header.TotalPayloadLength);
        _decodedBlocks = new byte[]?[_blockCount];
        _soliton = new RobustSoliton(_blockCount);
    }

    private static void ValidateFrameShape(FrameHeader header, byte[] payload)
    {
        if (header.BlockCount == 0) throw new InvalidDataException("Block count must be greater than zero");
        if (header.BlockSize == 0) throw new InvalidDataException("Block size must be greater than zero");
        if (header.TotalPayloadLength == 0) throw new InvalidDataException("Total payload length must be greater than zero");
        if (header.TotalPayloadLength > ContainerParser.MaxFileSize)
        {
            throw new InvalidDataException($"Payload length {header.TotalPayloadLength} exceeds maximum allowed ({ContainerParser.MaxFileSize} bytes)");
        }
        if (payload.Length != header.BlockSize)
        {
            throw new InvalidDataException($"Frame payload length {payload.Length} does not match declared block size {header.BlockSize}");
        }

        long paddedLength = (long)header.BlockCount * header.BlockSize;
        if (paddedLength > ContainerParser.MaxFileSize + header.BlockSize)
        {
            throw new InvalidDataException("Block parameters exceed maximum allowed memory bounds");
        }

        int expectedBlockCount = checked((int)((header.TotalPayloadLength + header.BlockSize - 1u) / header.BlockSize));
        if (expectedBlockCount != header.BlockCount)
        {
            throw new InvalidDataException($"Block count {header.BlockCount} is inconsistent with payload length {header.TotalPayloadLength} and block size {header.BlockSize}");
        }
    }

    private void EliminateSolvedBlocks(DecoderNode node)
    {
        var remaining = new List<int>(node.Neighbors.Count);
        foreach (int neighbor in node.Neighbors)
        {
            byte[]? solved = _decodedBlocks[neighbor];
            if (solved is null)
            {
                remaining.Add(neighbor);
                continue;
            }

            for (int i = 0; i < _blockSize; i++) node.Payload[i] ^= solved[i];
        }
        node.Neighbors = remaining;
    }

    private void ProcessRipple(DecoderNode initialNode)
    {
        var queue = new Queue<DecoderNode>();
        queue.Enqueue(initialNode);

        while (queue.Count > 0)
        {
            DecoderNode node = queue.Dequeue();
            if (node.Degree != 1) continue;

            int blockIndex = node.Neighbors[0];
            if (_decodedBlocks[blockIndex] is not null)
            {
                _frames.Remove(node.SequenceNumber);
                continue;
            }

            _decodedBlocks[blockIndex] = (byte[])node.Payload.Clone();
            _solvedCount++;
            _frames.Remove(node.SequenceNumber);

            if (_solvedCount == _blockCount)
            {
                _isComplete = true;
                return;
            }

            foreach ((uint sequence, DecoderNode otherNode) in _frames.ToList())
            {
                int neighborIndex = otherNode.Neighbors.IndexOf(blockIndex);
                if (neighborIndex < 0) continue;

                for (int i = 0; i < _blockSize; i++) otherNode.Payload[i] ^= node.Payload[i];
                otherNode.Neighbors.RemoveAt(neighborIndex);

                if (otherNode.Degree == 1) queue.Enqueue(otherNode);
                else if (otherNode.Degree == 0) _frames.Remove(sequence);
            }
        }
    }
}
