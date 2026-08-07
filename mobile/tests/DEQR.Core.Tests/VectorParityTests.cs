using System.Text.Json;
using DEQR.Core.Container;
using DEQR.Core.Fountain;
using DEQR.Core.PRNG;
using DEQR.Core.Protocol;
using DEQR.Core.Security;
using DEQR.Core.Validation;
using Xunit;

namespace DEQR.Core.Tests;

public sealed class VectorParityTests
{
    private static readonly string VectorRoot = FindVectorRoot();
    private static readonly JsonDocument Manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(VectorRoot, "expected.json")));

    [Theory]
    [InlineData("txtContainer")]
    [InlineData("pdfContainer")]
    [InlineData("zipContainer")]
    public void ContainerVectors_RoundTripByteForByte(string caseName)
    {
        JsonElement testCase = Cases.GetProperty(caseName);
        string file = testCase.GetProperty("file").GetString()!;
        byte[] golden = ReadVector(file);

        Assert.Equal(testCase.GetProperty("sizeBytes").GetInt32(), golden.Length);

        DeqrContainer parsed = ContainerParser.DeserializeContainer(golden);
        Assert.Equal(testCase.GetProperty("filename").GetString(), parsed.Metadata.Filename);
        Assert.Equal(testCase.GetProperty("mimeType").GetString(), parsed.Metadata.MimeType);
        Assert.Equal(testCase.GetProperty("originalSize").GetInt64(), parsed.Metadata.OriginalSize);
        Assert.Equal(testCase.GetProperty("timestamp").GetInt64(), parsed.Metadata.Timestamp);
        Assert.Equal(testCase.GetProperty("compressed").GetBoolean(), parsed.Metadata.Compressed);
        Assert.Equal(testCase.GetProperty("encrypted").GetBoolean(), parsed.Metadata.Encrypted);
        Assert.Equal(testCase.GetProperty("sha256Hex").GetString(), Convert.ToHexString(parsed.Metadata.Sha256).ToLowerInvariant());
        Assert.True(SHA256Verifier.Verify(parsed.Payload, parsed.Metadata.Sha256));

        byte[] reserialized = ContainerParser.SerializeContainer(parsed);
        Assert.Equal(golden, reserialized);
    }

    [Fact]
    public void EveryValidFrame_RoundTripsByteForByte()
    {
        foreach (string file in ValidFrameFiles())
        {
            byte[] golden = ReadVector(file);
            ProtocolFrame parsed = FrameSerializer.DeserializeFrame(golden);
            Assert.Equal(parsed.Header.BlockSize, parsed.Payload.Length);
            Assert.Equal(golden, FrameSerializer.SerializeFrame(parsed));
        }
    }

    [Fact]
    public void CSharpEncoder_MatchesEveryGoldenFrameByteForByte()
    {
        JsonElement stream = Cases.GetProperty("fountainStream");
        uint sessionId = stream.GetProperty("sessionId").GetUInt32();
        ushort blockSize = stream.GetProperty("blockSize").GetUInt16();
        byte[] payload = ReadVector("container-txt.bin");
        var encoder = new FountainEncoder(payload, blockSize, sessionId);

        string[] expectedFiles = ValidFrameFiles().ToArray();
        for (int sequence = 0; sequence < expectedFiles.Length; sequence++)
        {
            byte[] actual = FrameSerializer.SerializeFrame(encoder.NextFrame());
            byte[] expected = ReadVector(expectedFiles[sequence]);
            Assert.Equal(expected, actual);
        }
    }

    [Fact]
    public void Mulberry32_MatchesTypeScriptUint32VectorsExactly()
    {
        JsonElement vectors = Cases.GetProperty("prngVectors");
        foreach (JsonProperty seedVector in vectors.EnumerateObject())
        {
            uint seed = uint.Parse(seedVector.Name);
            var prng = new Mulberry32PRNG(seed);
            foreach (JsonElement expected in seedVector.Value.EnumerateArray())
            {
                Assert.Equal(expected.GetUInt32(), prng.NextUInt32());
            }
        }
    }

    [Fact]
    public void RobustSolitonAndNeighborSelection_MatchTypeScriptExpectations()
    {
        JsonElement stream = Cases.GetProperty("fountainStream");
        int blockCount = stream.GetProperty("blockCount").GetInt32();
        JsonElement expectations = stream.GetProperty("repairExpectations");

        foreach (JsonProperty property in expectations.EnumerateObject())
        {
            uint sequence = uint.Parse(property.Name);
            var prng = new Mulberry32PRNG(sequence);
            var soliton = new RobustSoliton(blockCount);
            int degree = soliton.SampleDegree(prng);
            int expectedDegree = property.Value.GetProperty("degree").GetInt32();
            Assert.Equal(expectedDegree, degree);

            int[] expectedNeighbors = property.Value.GetProperty("neighbors").EnumerateArray().Select(e => e.GetInt32()).ToArray();
            int[] actualNeighbors = FountainEncoder.SelectDistinctIndices(prng, degree, blockCount).ToArray();
            Assert.Equal(expectedNeighbors, actualNeighbors);
        }
    }

    [Fact]
    public void Decoder_MustCompleteAndReconstructExactContainer()
    {
        JsonElement systematic = Cases.GetProperty("fountainStream").GetProperty("systematicFrames");
        var decoder = new FountainDecoder();
        bool complete = false;

        foreach (JsonElement file in systematic.EnumerateArray())
        {
            ProtocolFrame frame = FrameSerializer.DeserializeFrame(ReadVector(file.GetString()!));
            complete = decoder.ReceiveFrame(frame);
        }

        Assert.True(complete);
        Assert.True(decoder.IsComplete);
        Assert.Equal(decoder.BlockCount, decoder.SolvedCount);
        Assert.Equal(ReadVector("container-txt.bin"), decoder.ReconstructPayload());
    }

    [Fact]
    public void DuplicateFrame_DoesNotAdvanceDecoderTwice()
    {
        ProtocolFrame frame = FrameSerializer.DeserializeFrame(ReadVector("frame-systematic-001.bin"));
        var decoder = new FountainDecoder();
        Assert.False(decoder.ReceiveFrame(frame));
        int solved = decoder.SolvedCount;
        Assert.False(decoder.ReceiveFrame(frame));
        Assert.Equal(solved, decoder.SolvedCount);
    }

    [Fact]
    public void CorruptChecksum_IsRejected()
    {
        Assert.Throws<InvalidDataException>(() => FrameSerializer.DeserializeFrame(ReadVector(Malformed.GetProperty("corruptCrcFrame").GetString()!)));
    }

    [Fact]
    public void TruncatedHeader_IsRejected()
    {
        Assert.Throws<ArgumentException>(() => FrameSerializer.DeserializeHeader(ReadVector(Malformed.GetProperty("truncatedFrame").GetString()!)));
    }

    [Fact]
    public void TrailingContainerBytes_AreRejected()
    {
        Assert.Throws<InvalidDataException>(() => ContainerParser.DeserializeContainer(ReadVector(Malformed.GetProperty("trailingContainer").GetString()!)));
    }

    [Fact]
    public void InconsistentSessionMetadata_IsRejected()
    {
        var decoder = new FountainDecoder();
        decoder.ReceiveFrame(FrameSerializer.DeserializeFrame(ReadVector("frame-systematic-001.bin")));
        ProtocolFrame inconsistent = FrameSerializer.DeserializeFrame(ReadVector(Malformed.GetProperty("inconsistentSessionFrame").GetString()!));
        Assert.Throws<InvalidDataException>(() => decoder.ReceiveFrame(inconsistent));
    }

    [Fact]
    public void OversizedPayloadDeclaration_IsRejectedBeforeAllocation()
    {
        ProtocolFrame oversized = FrameSerializer.DeserializeFrame(ReadVector(Malformed.GetProperty("oversizedPayloadFrame").GetString()!));
        Assert.Throws<InvalidDataException>(() => new FountainDecoder().ReceiveFrame(oversized));
    }

    [Fact]
    public void BlockShapeMismatch_IsRejected()
    {
        ProtocolFrame valid = FrameSerializer.DeserializeFrame(ReadVector("frame-systematic-001.bin"));
        var malformed = valid with { Payload = valid.Payload[..^1] };
        Assert.Throws<InvalidDataException>(() => new FountainDecoder().ReceiveFrame(malformed));
    }

    [Theory]
    [InlineData("../../etc/passwd", "passwd")]
    [InlineData("..\\..\\Windows\\System32\\cmd.exe", "cmd.exe")]
    [InlineData("normal_file.txt", "normal_file.txt")]
    [InlineData("  file_with_spaces.pdf  ", "file_with_spaces.pdf")]
    [InlineData("a<b>.txt", "a_b_.txt")]
    public void FilenameSanitizer_MatchesDesktopRules(string input, string expected)
    {
        Assert.Equal(expected, FilenameSanitizer.SanitizeFilename(input));
    }

    [Fact]
    public void Manifest_DescribesAllCommittedVectors()
    {
        Assert.Equal(1, Manifest.RootElement.GetProperty("protocolVersion").GetInt32());
        foreach (string file in ValidFrameFiles()) Assert.True(File.Exists(Path.Combine(VectorRoot, file)), file);
        foreach (JsonProperty malformed in Malformed.EnumerateObject()) Assert.True(File.Exists(Path.Combine(VectorRoot, malformed.Value.GetString()!)), malformed.Name);
    }

    private static JsonElement Cases => Manifest.RootElement.GetProperty("testCases");
    private static JsonElement Malformed => Cases.GetProperty("malformedAttackVectors");

    private static IEnumerable<string> ValidFrameFiles()
    {
        JsonElement stream = Cases.GetProperty("fountainStream");
        foreach (JsonElement e in stream.GetProperty("systematicFrames").EnumerateArray()) yield return e.GetString()!;
        foreach (JsonElement e in stream.GetProperty("repairFrames").EnumerateArray()) yield return e.GetString()!;
    }

    private static byte[] ReadVector(string filename) => File.ReadAllBytes(Path.Combine(VectorRoot, filename));

    private static string FindVectorRoot()
    {
        DirectoryInfo? dir = new(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "protocol", "test-vectors");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("Could not locate protocol/test-vectors directory");
    }
}
