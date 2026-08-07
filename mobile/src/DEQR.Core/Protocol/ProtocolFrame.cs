using System.Buffers.Binary;

namespace DEQR.Core.Protocol;

public record FrameHeader(
    byte ProtocolVersion,
    uint SessionId,
    ushort SegmentNumber,
    uint SequenceNumber,
    ushort BlockCount,
    ushort BlockSize,
    uint TotalPayloadLength
);

public record ProtocolFrame(
    FrameHeader Header,
    byte[] Payload
);

public static class FrameSerializer
{
    public const byte FrameProtocolVersion = 1;
    public const int HeaderSize = 20;

    public static byte CalculateChecksum(ReadOnlySpan<byte> buffer, int length)
    {
        if (length < 0 || length > buffer.Length)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }

        byte checksum = 0;
        for (int i = 0; i < length; i++)
        {
            checksum ^= buffer[i];
        }
        return checksum;
    }

    public static byte[] SerializeHeader(FrameHeader header)
    {
        if (header.ProtocolVersion != FrameProtocolVersion)
        {
            throw new InvalidOperationException($"Unsupported protocol version: {header.ProtocolVersion}");
        }

        byte[] buffer = new byte[HeaderSize];
        int offset = 0;

        buffer[offset++] = header.ProtocolVersion;
        BinaryPrimitives.WriteUInt32BigEndian(buffer.AsSpan(offset, 4), header.SessionId);
        offset += 4;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), header.SegmentNumber);
        offset += 2;
        BinaryPrimitives.WriteUInt32BigEndian(buffer.AsSpan(offset, 4), header.SequenceNumber);
        offset += 4;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), header.BlockCount);
        offset += 2;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), header.BlockSize);
        offset += 2;
        BinaryPrimitives.WriteUInt32BigEndian(buffer.AsSpan(offset, 4), header.TotalPayloadLength);
        offset += 4;

        buffer[offset] = CalculateChecksum(buffer.AsSpan(0, HeaderSize - 1), HeaderSize - 1);
        return buffer;
    }

    public static FrameHeader DeserializeHeader(ReadOnlySpan<byte> buffer)
    {
        if (buffer.Length < HeaderSize)
        {
            throw new ArgumentException($"Buffer too small for frame header: {buffer.Length} < {HeaderSize}");
        }

        byte expectedChecksum = CalculateChecksum(buffer, HeaderSize - 1);
        byte actualChecksum = buffer[HeaderSize - 1];
        if (expectedChecksum != actualChecksum)
        {
            throw new InvalidDataException("Frame header checksum mismatch (corrupted frame)");
        }

        int offset = 0;
        byte protocolVersion = buffer[offset++];
        if (protocolVersion != FrameProtocolVersion)
        {
            throw new InvalidDataException($"Unsupported protocol version in frame: {protocolVersion}");
        }

        uint sessionId = BinaryPrimitives.ReadUInt32BigEndian(buffer.Slice(offset, 4));
        offset += 4;
        ushort segmentNumber = BinaryPrimitives.ReadUInt16BigEndian(buffer.Slice(offset, 2));
        offset += 2;
        uint sequenceNumber = BinaryPrimitives.ReadUInt32BigEndian(buffer.Slice(offset, 4));
        offset += 4;
        ushort blockCount = BinaryPrimitives.ReadUInt16BigEndian(buffer.Slice(offset, 2));
        offset += 2;
        ushort blockSize = BinaryPrimitives.ReadUInt16BigEndian(buffer.Slice(offset, 2));
        offset += 2;
        uint totalPayloadLength = BinaryPrimitives.ReadUInt32BigEndian(buffer.Slice(offset, 4));

        return new FrameHeader(
            protocolVersion,
            sessionId,
            segmentNumber,
            sequenceNumber,
            blockCount,
            blockSize,
            totalPayloadLength
        );
    }

    public static byte[] SerializeFrame(ProtocolFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);
        byte[] headerBytes = SerializeHeader(frame.Header);
        byte[] result = new byte[headerBytes.Length + frame.Payload.Length];
        Buffer.BlockCopy(headerBytes, 0, result, 0, headerBytes.Length);
        Buffer.BlockCopy(frame.Payload, 0, result, headerBytes.Length, frame.Payload.Length);
        return result;
    }

    public static ProtocolFrame DeserializeFrame(ReadOnlySpan<byte> buffer)
    {
        FrameHeader header = DeserializeHeader(buffer);
        byte[] payload = buffer.Slice(HeaderSize).ToArray();
        return new ProtocolFrame(header, payload);
    }
}
