using DEQR.Core.Protocol;

namespace DEQR.Core.Receiver;

public interface IRawQrFrameParser
{
    ProtocolFrame Parse(ReadOnlyMemory<byte> rawFrameBytes);
}

/// <summary>
/// Parses raw bytes emitted by a future QR decoder adapter. This boundary
/// intentionally accepts bytes only; text representations are not valid DEQR
/// transport inputs.
/// </summary>
public sealed class RawQrFrameParser : IRawQrFrameParser
{
    public ProtocolFrame Parse(ReadOnlyMemory<byte> rawFrameBytes)
        => FrameSerializer.DeserializeFrame(rawFrameBytes.Span);
}
