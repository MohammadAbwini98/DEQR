using DEQR.Core.Container;
using DEQR.Core.Fountain;

namespace DEQR.Core.Receiver;

public enum ReceiverState
{
    Ready,
    RequestingPermission,
    Scanning,
    Receiving,
    Reconstructing,
    Verifying,
    Saving,
    Completed,
    Failed,
    Cancelled
}

public sealed record ReceiverFrameResult(
    ReceiverState State,
    bool Accepted,
    bool Rejected,
    int SolvedBlocks,
    int BlockCount,
    string? RejectionReason);

public sealed class ReceiverSession
{
    private readonly IRawQrFrameParser _parser;
    private readonly FountainDecoder _decoder = new();

    public ReceiverSession(IRawQrFrameParser? parser = null)
    {
        _parser = parser ?? new RawQrFrameParser();
    }

    public ReceiverState State { get; private set; } = ReceiverState.Ready;

    public string? FailureReason { get; private set; }

    public void BeginPermissionRequest()
    {
        EnsureState(ReceiverState.Ready);
        State = ReceiverState.RequestingPermission;
    }

    public void BeginScanning()
    {
        if (State is not (ReceiverState.Ready or ReceiverState.RequestingPermission))
        {
            throw new InvalidOperationException($"Cannot begin scanning while receiver is {State}.");
        }

        State = ReceiverState.Scanning;
    }

    public ReceiverFrameResult ReceiveRawFrame(ReadOnlyMemory<byte> rawFrameBytes)
    {
        if (State is not (ReceiverState.Scanning or ReceiverState.Receiving))
        {
            throw new InvalidOperationException($"Cannot receive a frame while receiver is {State}.");
        }

        try
        {
            var frame = _parser.Parse(rawFrameBytes);
            bool completed = _decoder.ReceiveFrame(frame);
            if (completed)
            {
                State = ReceiverState.Reconstructing;
            }
            else
            {
                State = ReceiverState.Receiving;
            }

            return new ReceiverFrameResult(State, Accepted: true, Rejected: false, _decoder.SolvedCount, _decoder.BlockCount, null);
        }
        catch (ArgumentException exception)
        {
            return Rejected(exception.Message);
        }
        catch (InvalidDataException exception)
        {
            return Rejected(exception.Message);
        }
    }

    public VerifiedReceivedFile ReconstructAndVerify()
    {
        EnsureState(ReceiverState.Reconstructing);

        try
        {
            State = ReceiverState.Verifying;
            byte[] containerBytes = _decoder.ReconstructPayload();
            DeqrContainer container = ContainerParser.DeserializeContainer(containerBytes);
            VerifiedReceivedFile result = ReceivedFileReconstructor.ReconstructAndVerify(container);
            State = ReceiverState.Saving;
            return result;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidDataException or InvalidOperationException or OverflowException)
        {
            FailureReason = exception.Message;
            State = ReceiverState.Failed;
            throw;
        }
    }

    public void CompleteSaving()
    {
        EnsureState(ReceiverState.Saving);
        State = ReceiverState.Completed;
    }

    public void Fail(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        if (State is ReceiverState.Completed or ReceiverState.Cancelled)
        {
            throw new InvalidOperationException($"Cannot fail a receiver session that is {State}.");
        }

        FailureReason = reason;
        State = ReceiverState.Failed;
    }

    public void Cancel()
    {
        if (State is ReceiverState.Completed or ReceiverState.Cancelled)
        {
            throw new InvalidOperationException($"Cannot cancel a receiver session that is {State}.");
        }

        State = ReceiverState.Cancelled;
    }

    private ReceiverFrameResult Rejected(string reason)
        => new(State, Accepted: false, Rejected: true, _decoder.SolvedCount, _decoder.BlockCount, reason);

    private void EnsureState(ReceiverState expected)
    {
        if (State != expected)
        {
            throw new InvalidOperationException($"Expected receiver state {expected}, but was {State}.");
        }
    }
}
