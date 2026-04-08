@echo off
cd /d "%~dp0"
if not exist build mkdir build
javac -cp "C:\Program Files\Bookmap\lib\bm-l1api.jar;C:\Program Files\Bookmap\lib\bm-simplified-api-wrapper.jar" -d build src\main\java\com\nqtrader\bookmap\BboForwarder.java
if %errorlevel% neq 0 (
    echo COMPILE_FAILED
    exit /b 1
)
echo COMPILE_OK
cd build
jar cf ..\nq-bbo-forwarder.jar com
cd ..
echo JAR_CREATED
dir nq-bbo-forwarder.jar
