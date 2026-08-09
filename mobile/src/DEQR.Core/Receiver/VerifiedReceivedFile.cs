using System.IO.Compression;
using DEQR.Core.Container;
using DEQR.Core.Validation;

namespace DEQR.Core.Receiver;

public sealed record VerifiedReceivedFile(ContainerMetadata Metadata, byte[] Bytes);

public static class ReceivedFileReconstructor
{
    public static VerifiedReceivedFile ReconstructAndVerify(DeqrContainer container)
    {
        ArgumentNullException.ThrowIfNull(container);

        if (container.Metadata.Encrypted)
        {
            throw new InvalidDataException("Encrypted DEQR payloads are not supported by the current receiver.");
        }

        byte[] originalBytes = container.Metadata.Compressed
            ? DecompressGzip(container.Payload, container.Metadata.OriginalSize)
            : (byte[])container.Payload.Clone();

        if (originalBytes.LongLength != container.Metadata.OriginalSize)
        {
            throw new InvalidDataException($"Reconstructed file length {originalBytes.LongLength} does not match declared length {container.Metadata.OriginalSize}.");
        }

        if (!SHA256Verifier.Verify(originalBytes, container.Metadata.Sha256))
        {
            throw new InvalidDataException("Reconstructed file SHA-256 verification failed.");
        }

        return new VerifiedReceivedFile(container.Metadata, originalBytes);
    }

    private static byte[] DecompressGzip(byte[] compressedBytes, long expectedLength)
    {
        using var input = new MemoryStream(compressedBytes, writable: false);
        using var gzip = new GZipStream(input, CompressionMode.Decompress, leaveOpen: false);
        using var output = new MemoryStream(checked((int)expectedLength));
        byte[] buffer = new byte[81920];
        long totalWritten = 0;

        while (true)
        {
            int read = gzip.Read(buffer, 0, buffer.Length);
            if (read == 0) break;

            totalWritten = checked(totalWritten + read);
            if (totalWritten > expectedLength)
            {
                throw new InvalidDataException("Compressed payload expands beyond its declared original length.");
            }

            output.Write(buffer, 0, read);
        }

        return output.ToArray();
    }
}
