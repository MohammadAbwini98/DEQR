using System.Buffers.Binary;
using System.Text;
using DEQR.Core.Security;

namespace DEQR.Core.Container;

public record ContainerMetadata(
    ushort ProtocolVersion,
    string Filename,
    string MimeType,
    long OriginalSize,
    bool Compressed,
    bool Encrypted,
    long Timestamp,
    byte[] Sha256
);

public record DeqrContainer(
    ContainerMetadata Metadata,
    byte[] Payload
);

public static class ContainerParser
{
    public const uint MaxFileSize = 64 * 1024 * 1024;
    public const ushort ContainerProtocolVersion = 1;
    public static readonly byte[] DeqrMagic = "DEQR"u8.ToArray();

    public static byte[] SerializeContainer(DeqrContainer container)
    {
        ArgumentNullException.ThrowIfNull(container);
        ContainerMetadata metadata = container.Metadata;
        byte[] payload = container.Payload;

        string safeFilename = FilenameSanitizer.SanitizeFilename(metadata.Filename);
        byte[] filenameBytes = Encoding.UTF8.GetBytes(safeFilename);
        byte[] mimeBytes = Encoding.UTF8.GetBytes(metadata.MimeType);

        if (metadata.Sha256.Length != 32)
        {
            throw new ArgumentException("SHA-256 digest must be exactly 32 bytes");
        }
        if (metadata.OriginalSize < 0 || metadata.OriginalSize > MaxFileSize)
        {
            throw new ArgumentException($"File size {metadata.OriginalSize} is outside the allowed range 0-{MaxFileSize} bytes");
        }
        if (metadata.ProtocolVersion != ContainerProtocolVersion)
        {
            throw new ArgumentException($"Unsupported protocol version: {metadata.ProtocolVersion}");
        }
        if (metadata.Timestamp < 0)
        {
            throw new ArgumentException("Timestamp must be non-negative");
        }
        if (filenameBytes.Length > ushort.MaxValue || mimeBytes.Length > ushort.MaxValue)
        {
            throw new ArgumentException("Filename or MIME type exceeds protocol length limits");
        }
        if (!metadata.Compressed && payload.LongLength != metadata.OriginalSize)
        {
            throw new ArgumentException($"Uncompressed payload length {payload.LongLength} does not match declared original size {metadata.OriginalSize}");
        }

        int headerSize = 4 + 2 + 2 + filenameBytes.Length + 2 + mimeBytes.Length + 8 + 1 + 1 + 8 + 32;
        int totalSize = checked(headerSize + payload.Length);
        byte[] buffer = new byte[totalSize];
        int offset = 0;

        DeqrMagic.CopyTo(buffer.AsSpan(offset, 4));
        offset += 4;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), metadata.ProtocolVersion);
        offset += 2;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), checked((ushort)filenameBytes.Length));
        offset += 2;
        filenameBytes.CopyTo(buffer.AsSpan(offset, filenameBytes.Length));
        offset += filenameBytes.Length;
        BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), checked((ushort)mimeBytes.Length));
        offset += 2;
        mimeBytes.CopyTo(buffer.AsSpan(offset, mimeBytes.Length));
        offset += mimeBytes.Length;
        BinaryPrimitives.WriteUInt64BigEndian(buffer.AsSpan(offset, 8), checked((ulong)metadata.OriginalSize));
        offset += 8;
        buffer[offset++] = metadata.Compressed ? (byte)0x01 : (byte)0x00;
        buffer[offset++] = metadata.Encrypted ? (byte)0x01 : (byte)0x00;
        BinaryPrimitives.WriteUInt64BigEndian(buffer.AsSpan(offset, 8), checked((ulong)metadata.Timestamp));
        offset += 8;
        metadata.Sha256.CopyTo(buffer.AsSpan(offset, 32));
        offset += 32;
        payload.CopyTo(buffer.AsSpan(offset, payload.Length));

        return buffer;
    }

    public static DeqrContainer DeserializeContainer(ReadOnlySpan<byte> data)
    {
        int offset = 0;

        Require(data, offset, 4, "magic bytes");
        ReadOnlySpan<byte> magic = data.Slice(offset, 4);
        if (!magic.SequenceEqual(DeqrMagic))
        {
            throw new InvalidDataException("Invalid container magic: expected DEQR");
        }
        offset += 4;

        Require(data, offset, 2, "protocol version");
        ushort protocolVersion = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset, 2));
        offset += 2;
        if (protocolVersion != ContainerProtocolVersion)
        {
            throw new InvalidDataException($"Unsupported protocol version: {protocolVersion}");
        }

        Require(data, offset, 2, "filename length");
        ushort filenameLen = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset, 2));
        offset += 2;
        Require(data, offset, filenameLen, "filename");
        string filename = FilenameSanitizer.SanitizeFilename(Encoding.UTF8.GetString(data.Slice(offset, filenameLen)));
        offset += filenameLen;

        Require(data, offset, 2, "MIME type length");
        ushort mimeLen = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset, 2));
        offset += 2;
        Require(data, offset, mimeLen, "MIME type");
        string mimeType = Encoding.UTF8.GetString(data.Slice(offset, mimeLen));
        offset += mimeLen;

        Require(data, offset, 8, "file size");
        ulong originalSizeRaw = BinaryPrimitives.ReadUInt64BigEndian(data.Slice(offset, 8));
        offset += 8;
        if (originalSizeRaw > MaxFileSize)
        {
            throw new InvalidDataException($"Declared file size {originalSizeRaw} exceeds maximum {MaxFileSize} bytes");
        }
        long originalSize = checked((long)originalSizeRaw);

        Require(data, offset, 1, "compression flag");
        byte compressionFlag = data[offset++];
        if (compressionFlag > 1)
        {
            throw new InvalidDataException($"Invalid compression flag: {compressionFlag}");
        }
        bool compressed = compressionFlag == 1;

        Require(data, offset, 1, "encryption flag");
        byte encryptionFlag = data[offset++];
        if (encryptionFlag > 1)
        {
            throw new InvalidDataException($"Invalid encryption flag: {encryptionFlag}");
        }
        bool encrypted = encryptionFlag == 1;

        Require(data, offset, 8, "timestamp");
        ulong timestampRaw = BinaryPrimitives.ReadUInt64BigEndian(data.Slice(offset, 8));
        offset += 8;
        if (timestampRaw > long.MaxValue)
        {
            throw new InvalidDataException("Container timestamp exceeds supported range");
        }
        long timestamp = (long)timestampRaw;

        Require(data, offset, 32, "SHA-256 digest");
        byte[] sha256 = data.Slice(offset, 32).ToArray();
        offset += 32;

        byte[] payload = data.Slice(offset).ToArray();
        offset += payload.Length;

        if (!compressed && payload.LongLength != originalSize)
        {
            throw new InvalidDataException($"Container rejected: trailing unconsumed bytes detected or payload truncated. Expected {originalSize} bytes, got {payload.LongLength} bytes");
        }
        if (offset != data.Length)
        {
            throw new InvalidDataException($"Container rejected: trailing unconsumed bytes detected ({data.Length - offset} bytes)");
        }

        return new DeqrContainer(
            new ContainerMetadata(protocolVersion, filename, mimeType, originalSize, compressed, encrypted, timestamp, sha256),
            payload
        );
    }

    private static void Require(ReadOnlySpan<byte> data, int offset, int count, string field)
    {
        if (count < 0 || offset < 0 || offset > data.Length || count > data.Length - offset)
        {
            throw new InvalidDataException($"Container truncated: incomplete or missing {field}");
        }
    }
}
