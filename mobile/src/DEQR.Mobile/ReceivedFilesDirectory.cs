namespace DEQR.Mobile;

public static class ReceivedFilesDirectory
{
    private const string ReceivedDirectoryName = "Received";

    public static string Path { get; private set; } = string.Empty;

    public static void Initialize()
    {
        var documentsDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (string.IsNullOrWhiteSpace(documentsDirectory))
        {
            throw new InvalidOperationException("The application Documents directory is unavailable.");
        }

        Path = System.IO.Path.Combine(documentsDirectory, ReceivedDirectoryName);
        Directory.CreateDirectory(Path);
    }
}
