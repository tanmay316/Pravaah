/**
 * Auth Screen — Sign in & Sign up (Google Auth & Email/Password)
 *
 * Style reference: Origin Financial (Midnight Gallery of quiet wealth).
 * Canvas: Obsidian #0f1011, Graphite Card #18191b, Pure #ffffff primary action.
 */

import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { signInWithEmail, signUpWithEmail, signInWithGoogle } from "../lib/firebase";
import { theme } from "../lib/theme";

export default function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (isSignUp) {
        await signUpWithEmail(email.trim(), password);
      } else {
        await signInWithEmail(email.trim(), password);
      }
      router.replace("/");
    } catch (err: any) {
      setError(err.message || "Authentication failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError("");
    try {
      await signInWithGoogle();
      router.replace("/");
    } catch (err: any) {
      setError(err.message || "Google sign-in was cancelled or encountered an issue.");
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Subtle Ambient Lunar Glow */}
        <View style={styles.ambientGlow} />

        <View style={styles.card}>
          {/* Brand Logo */}
          <View style={styles.brandLogoWrapper}>
            <Image
              source={require("../assets/pravaah_navbar_logo.png")}
              style={styles.brandLogoImage}
              resizeMode="contain"
              accessibilityLabel="Pravaah"
            />
          </View>

          {/* Eyebrow Pill */}
          <View style={styles.eyebrowContainer}>
            <Text style={styles.eyebrowText}>PRAVAAH SPOKEN ENGLISH • AI COACH</Text>
          </View>

          <Text style={styles.brandTitle}>
            <Text style={styles.brandTitleItalic}>Own</Text> your voice.
          </Text>
          <Text style={styles.brandSubtitle}>
            Quiet confidence, natural phrasing, and effortless fluency.
          </Text>

          {/* Google Sign In Button */}
          <Pressable
            style={({ pressed }) => [
              styles.googleButton,
              pressed && styles.ghostPressed,
              googleLoading && styles.buttonDisabled,
            ]}
            onPress={handleGoogleSignIn}
            disabled={googleLoading || loading}
          >
            {googleLoading ? (
              <ActivityIndicator color={theme.colors.pure} />
            ) : (
              <View style={styles.googleButtonContent}>
                <View style={styles.googleIconBadge}>
                  <Text style={styles.googleIconText}>G</Text>
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </View>
            )}
          </Pressable>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR WITH EMAIL</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Input Group: Email */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>EMAIL ADDRESS</Text>
            <TextInput
              style={styles.input}
              placeholder="name@domain.com"
              placeholderTextColor={theme.colors.fog}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
            />
          </View>

          {/* Input Group: Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>PASSWORD</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={theme.colors.fog}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Primary Action Button (Pure White on Dark) */}
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
              loading && styles.buttonDisabled,
            ]}
            onPress={handleSubmit}
            disabled={loading || googleLoading}
          >
            {loading ? (
              <ActivityIndicator color={theme.colors.void} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {isSignUp ? "Create Account →" : "Sign In →"}
              </Text>
            )}
          </Pressable>

          {/* Toggle Sign in / Sign up */}
          <Pressable
            style={styles.toggleContainer}
            onPress={() => {
              setIsSignUp(!isSignUp);
              setError("");
            }}
          >
            <Text style={styles.toggleText}>
              {isSignUp
                ? "Already have an account? Sign In"
                : "New to Pravaah? Create an account"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.xl,
    minHeight: "100%",
  },
  ambientGlow: {
    position: "absolute",
    top: "15%",
    left: "50%",
    transform: [{ translateX: -150 }],
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(132, 125, 255, 0.04)",
    pointerEvents: "none",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 36,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  brandLogoWrapper: {
    alignItems: "center",
    marginBottom: 20,
  },
  brandLogoImage: {
    width: 170,
    height: 48,
  },
  eyebrowContainer: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    alignSelf: "flex-start",
    marginBottom: 18,
  },
  eyebrowText: {
    color: theme.colors.irisGleam,
    fontSize: 9,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    fontWeight: "500",
  },
  brandTitle: {
    color: theme.colors.pure,
    fontSize: 28,
    fontFamily: theme.fonts.serif,
    lineHeight: 34,
    marginBottom: 8,
  },
  brandTitleItalic: {
    fontStyle: "italic",
    fontFamily: theme.fonts.serif,
  },
  brandSubtitle: {
    color: theme.colors.ash,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  googleButton: {
    height: 48,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  googleButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  googleIconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.pure,
    justifyContent: "center",
    alignItems: "center",
  },
  googleIconText: {
    color: theme.colors.void,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: theme.fonts.mono,
  },
  googleButtonText: {
    color: theme.colors.pure,
    fontSize: 14,
    fontWeight: "500",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.borderMuted,
  },
  dividerText: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  input: {
    backgroundColor: theme.colors.obsidian,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    color: theme.colors.pure,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorBanner: {
    backgroundColor: "rgba(255, 82, 82, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
    borderRadius: theme.radii.sm,
    padding: 10,
    marginBottom: 16,
  },
  errorText: {
    color: theme.colors.crimsonError,
    fontSize: 12,
    textAlign: "center",
  },
  primaryButton: {
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 20,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  primaryButtonText: {
    color: theme.colors.void,
    fontSize: 14,
    fontWeight: "600",
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  ghostPressed: {
    backgroundColor: theme.colors.glassFillHover,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  toggleContainer: {
    alignItems: "center",
    paddingVertical: 8,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  toggleText: {
    color: theme.colors.ash,
    fontSize: 13,
  },
});
