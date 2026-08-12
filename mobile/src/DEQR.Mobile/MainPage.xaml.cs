namespace DEQR.Mobile;

public partial class MainPage : ContentPage
{
    public MainPage()
    {
        InitializeComponent();
        ReceivedDirectoryLabel.Text = $"Received files directory: {ReceivedFilesDirectory.Path}";
    }
}
