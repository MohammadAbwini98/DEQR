namespace DEQR.Mobile;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        ReceivedFilesDirectory.Initialize();
    }

    protected override Window CreateWindow(IActivationState? activationState)
        => new(new MainPage());
}
