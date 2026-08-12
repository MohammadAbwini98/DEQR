namespace DEQR.Core.Capture;

public sealed record CameraFrame(
    ReadOnlyMemory<byte> PixelBytes,
    int Width,
    int Height,
    DateTimeOffset CapturedAt);

/// <summary>
/// Platform adapter boundary for camera acquisition. IOS-2 provides no
/// implementation, so it cannot open a camera or request permission.
/// </summary>
public interface ICameraFrameSource : IAsyncDisposable
{
    Task StartAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<CameraFrame> GetFramesAsync(CancellationToken cancellationToken);

    Task StopAsync(CancellationToken cancellationToken);
}
