using System.IO.Compression;
using DEQR.Core.Container;
using DEQR.Core.Receiver;
using DEQR.Core.Security;
using DEQR.Core.Storage;
using DEQR.Core.Validation;
using Xunit;

namespace DEQR.Core.Tests;

public sealed class ReceiverPipelineTests
{
    private static readonly string VectorRoot = FindVectorRoot();

    [Fact]
    public void DesktopSystematicFrames_ReconstructAndVerifyByteForByte()
    {
        var session = new ReceiverSession();
        session.BeginPermissionRequest();
        session.BeginScanning();

        for (int frameIndex = 1; frameIndex <= 5; frameIndex++)
        {
            ReceiverFrameResult result = session.ReceiveRawFrame(ReadVector($"frame-systematic-{frameIndex:000}.bin"));
            Assert.True(result.Accepted);
        }

        Assert.Equal(ReceiverState.Reconstructing, session.State);
        VerifiedReceivedFile file = session.ReconstructAndVerify();
        Assert.Equal("hello.txt", file.Metadata.Filename);
        Assert.Equal(ReadContainerPayload("container-txt.bin"), file.Bytes);
        Assert.True(SHA256Verifier.Verify(file.Bytes, file.Metadata.Sha256));
        Assert.Equal(ReceiverState.Saving, session.State);

        session.CompleteSaving();
        Assert.Equal(ReceiverState.Completed, session.State);
    }

    [Fact]
    public void InvalidOrInconsistentDesktopFrames_AreRejectedWithoutAdvancingSession()
    {
        var session = new ReceiverSession();
        session.BeginScanning();
        ReceiverFrameResult first = session.ReceiveRawFrame(ReadVector("frame-systematic-001.bin"));
        ReceiverFrameResult corrupt = session.ReceiveRawFrame(ReadVector("corrupt-frame-crc.bin"));
        ReceiverFrameResult inconsistent = session.ReceiveRawFrame(ReadVector("inconsistent-session-frame.bin"));

        Assert.True(first.Accepted);
        Assert.True(corrupt.Rejected);
        Assert.True(inconsistent.Rejected);
        Assert.Equal(1, session.ReceiveRawFrame(ReadVector("frame-systematic-001.bin")).SolvedBlocks);
        Assert.Equal(ReceiverState.Receiving, session.State);
    }

    [Fact]
    public void OutOfOrderDesktopSystematicFrames_ReconstructExactly()
    {
        var session = new ReceiverSession();
        session.BeginScanning();

        foreach (int frameIndex in new[] { 3, 1, 5, 2, 4 })
        {
            ReceiverFrameResult result = session.ReceiveRawFrame(ReadVector($"frame-systematic-{frameIndex:000}.bin"));
            Assert.True(result.Accepted);
        }

        VerifiedReceivedFile file = session.ReconstructAndVerify();
        Assert.Equal(ReadContainerPayload("container-txt.bin"), file.Bytes);
    }

    [Fact]
    public void CompressedPayload_IsExpandedToDeclaredLengthAndHashVerified()
    {
        byte[] original = new byte[] { 0x62, 0x69, 0x6E, 0x61, 0x72, 0x79, 0x00, 0x70, 0x61, 0x79, 0x6C, 0x6F, 0x61, 0x64, 0xFF };
        byte[] compressed = Compress(original);
        var metadata = new ContainerMetadata(
            ContainerParser.ContainerProtocolVersion,
            "compressed.bin",
            "application/octet-stream",
            original.Length,
            Compressed: true,
            Encrypted: false,
            Timestamp: 0,
            SHA256Verifier.ComputeHash(original));

        VerifiedReceivedFile result = ReceivedFileReconstructor.ReconstructAndVerify(new DeqrContainer(metadata, compressed));
        Assert.Equal(original, result.Bytes);
    }

    [Fact]
    public async Task ReceivedFileStore_SanitizesAndAllocatesCollisionSafeNames()
    {
        string directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"deqr-receiver-{Guid.NewGuid():N}");
        byte[] content = "safe payload"u8.ToArray();
        var metadata = new ContainerMetadata(1, "..\\unsafe.txt", "text/plain", content.Length, false, false, 0, SHA256Verifier.ComputeHash(content));
        var file = new VerifiedReceivedFile(metadata, content);

        try
        {
            string first = await ReceivedFileStore.WriteAsync(directory, file);
            string second = await ReceivedFileStore.WriteAsync(directory, file);

            Assert.Equal("unsafe.txt", System.IO.Path.GetFileName(first));
            Assert.Equal("unsafe (1).txt", System.IO.Path.GetFileName(second));
            Assert.Equal(content, await File.ReadAllBytesAsync(first));
            Assert.Equal(content, await File.ReadAllBytesAsync(second));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task BlockedExtension_IsNotWritten()
    {
        byte[] content = "safe payload"u8.ToArray();
        var metadata = new ContainerMetadata(1, "setup.exe", "application/octet-stream", content.Length, false, false, 0, SHA256Verifier.ComputeHash(content));
        var file = new VerifiedReceivedFile(metadata, content);
        string directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"deqr-receiver-{Guid.NewGuid():N}");

        Assert.True(FilenameSanitizer.IsBlockedExtension(file.Metadata.Filename));
        await Assert.ThrowsAsync<InvalidDataException>(() => ReceivedFileStore.WriteAsync(directory, file));
        Assert.False(Directory.Exists(directory));
    }

    private static byte[] ReadContainerPayload(string filename)
        => ContainerParser.DeserializeContainer(ReadVector(filename)).Payload;

    private static byte[] ReadVector(string filename)
        => File.ReadAllBytes(System.IO.Path.Combine(VectorRoot, filename));

    private static byte[] Compress(byte[] value)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            gzip.Write(value, 0, value.Length);
        }

        return output.ToArray();
    }

    private static string FindVectorRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string candidate = System.IO.Path.Combine(directory.FullName, "protocol", "test-vectors");
            if (Directory.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate protocol/test-vectors directory");
    }
}
