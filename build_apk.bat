@echo off
REM Builds a release APK locally (no EAS). Output: apk\pravaah-release.apk
REM Needs: Node, Android Studio (SDK + bundled JDK). First run is slow (native C++ compile);
REM later runs reuse the build and take a few minutes.
REM Usage: build_apk.bat            (arm64 phones only, fastest)
REM        build_apk.bat all        (all ABIs, also runs on x86_64 emulators)
REM        build_apk.bat clean      (regenerate android\ from scratch; slow, use after native dependency changes)
setlocal

set "ROOT=%~dp0"
set "APP=%ROOT%apps\expo"
set "ABIS=arm64-v8a"
set "CLEAN="
for %%A in (%*) do (
    if /i "%%~A"=="all" set "ABIS=armeabi-v7a,arm64-v8a,x86,x86_64"
    if /i "%%~A"=="clean" set "CLEAN=--clean"
)
set "LOG=%ROOT%apk\gradle-build.log"

REM React Native 0.76's Gradle does not run on Java 25; prefer Android Studio's bundled JDK.
if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
)
if not defined JAVA_HOME (
    echo [x] JAVA_HOME not set and Android Studio JDK not found. Install Android Studio or JDK 17.
    exit /b 1
)
set "PATH=%JAVA_HOME%\bin;%PATH%"

if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%\platform-tools" (
    echo [x] Android SDK not found at %ANDROID_HOME%. Install it from Android Studio ^> SDK Manager.
    exit /b 1
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
REM Non-interactive prebuild (skips the "uncommitted changes" prompt).
set "CI=1"

cd /d "%APP%" || exit /b 1

if not exist node_modules (
    echo [1/4] Installing npm packages...
    call npm install || exit /b 1
) else (
    echo [1/4] node_modules present, skipping npm install
)

echo [2/4] Generating native Android project from app.json...
REM --clean wipes android\ and forces a full native rebuild (~1h), so it is opt-in.
call npx expo prebuild --platform android %CLEAN% --no-install || exit /b 1

if not exist "%ROOT%apk" mkdir "%ROOT%apk"
echo [3/4] Building release APK for %ABIS% ...
echo       Compiler output goes to %LOG%
cd /d "%APP%\android" || exit /b 1
REM Third-party codegen emits harmless C++/Gradle deprecation warnings; keep them out of the console.
call gradlew.bat assembleRelease -PreactNativeArchitectures=%ABIS% ^
    --parallel --build-cache --warning-mode none ^
    "-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g" > "%LOG%" 2>&1
if errorlevel 1 (
    echo [x] Gradle build failed. Last lines of %LOG%:
    powershell -NoProfile -Command "Get-Content -Tail 40 '%LOG%'"
    echo If you see "Filename longer than 260 characters", enable Windows long paths.
    exit /b 1
)
powershell -NoProfile -Command "Get-Content '%LOG%' | Select-String 'BUILD SUCCESSFUL' | ForEach-Object { '      ' + $_.Line }"

echo [4/4] Copying APK...
copy /y "%APP%\android\app\build\outputs\apk\release\app-release.apk" "%ROOT%apk\pravaah-release.apk" >nul || exit /b 1

echo.
echo Done: %ROOT%apk\pravaah-release.apk
echo Signing key SHA-1 (registered in Firebase for Google sign-in):
REM stderr carries keytool's notes about the stock RN debug keystore format; not actionable here.
"%JAVA_HOME%\bin\keytool.exe" -list -v -keystore "%APP%\android\app\debug.keystore" -alias androiddebugkey -storepass android -keypass android 2>nul | findstr /c:"SHA1:"
echo Uninstall any EAS-built Pravaah first: Android refuses updates signed with a different key.
endlocal
