import traceback

try:
    import kokoro
    print("kokoro attributes:", dir(kokoro))
    from kokoro import KPipeline
    print("KPipeline imported successfully")
    pipeline = KPipeline(lang_code='a')
    print("KPipeline initialized")
    generator = pipeline("Hello world", voice='af_heart', speed=1.0)
    for i, (gs, ps, audio) in enumerate(generator):
        print(f"Chunk {i}: audio shape {audio.shape}")
except Exception as e:
    print("Error:")
    traceback.print_exc()
