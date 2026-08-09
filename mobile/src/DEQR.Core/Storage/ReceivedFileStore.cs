using DEQR.Core.Receiver;
using DEQR.Core.Security;

namespace DEQR.Core.Storage;

public static class ReceivedFileStore
{
    public static async Task<string> WriteAsync(
        string receivedDirectory,
        VerifiedReceivedFile receivedFile,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(receivedDirectory);
        ArgumentNullException.ThrowIfNull(receivedFile);

        string safeFilename = FilenameSanitizer.SanitizeFilename(receivedFile.Metadata.Filename);
        if (FilenameSanitizer.IsBlockedExtension(safeFilename))
        {
            throw new InvalidDataException($"Saving {safeFilename} is blocked by the DEQR file safety policy.");
        }

        Directory.CreateDirectory(receivedDirectory);
        string stem = System.IO.Path.GetFileNameWithoutExtension(safeFilename);
        string extension = System.IO.Path.GetExtension(safeFilename);

        for (int collisionNumber = 0; collisionNumber < 10_000; collisionNumber++)
        {
            string candidateName = collisionNumber == 0
                ? safeFilename
                : $"{stem} ({collisionNumber}){extension}";
            string candidatePath = System.IO.Path.Combine(receivedDirectory, candidateName);

            try
            {
                await using var stream = new FileStream(
                    candidatePath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    bufferSize: 81920,
                    useAsync: true);
                await stream.WriteAsync(receivedFile.Bytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                return candidatePath;
            }
            catch (IOException) when (File.Exists(candidatePath))
            {
                // CreateNew is atomic. A concurrent or previous transfer owns
                // this name, so safely try a deterministic collision suffix.
            }
        }

        throw new IOException("Could not allocate a unique received-file name after 10,000 attempts.");
    }
}
