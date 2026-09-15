/**
 * Pravaah — Mobile Authentication Screen
 *
 * Modern mobile onboarding experience with segmented control, Google Auth,
 * email/password forms, and fluid touch feedback.
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { signInWithEmail, signUpWithEmail, signInWithGoogle, sendPasswordReset } from "../lib/firebase";
import { theme } from "../lib/theme";

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");

  // Forgot-password panel replaces the sign-in/sign-up form in place; it does not navigate.
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetSent, setResetSent] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Please enter both email and password.");
      return;
    }
    if (isSignUp && !fullName.trim()) {
      setError("Please enter your name so your coach can address you.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (isSignUp) {
        await signUpWithEmail(email.trim(), password, fullName.trim());
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

  const openForgotPassword = () => {
    setResetEmail(email.trim());
    setResetError("");
    setResetSent(false);
    setShowForgotPassword(true);
  };

  const closeForgotPassword = () => {
    setShowForgotPassword(false);
    setResetError("");
    setResetSent(false);
  };

  const handleSendResetEmail = async () => {
    const target = resetEmail.trim();
    if (!target) {
      setResetError("Enter your email address.");
      return;
    }
    setResetLoading(true);
    setResetError("");
    try {
      await sendPasswordReset(target);
      setResetSent(true);
    } catch (err: any) {
      setResetError(err.message || "Could not send the reset email. Please try again.");
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: Math.max(insets.top + 20, 40), paddingBottom: Math.max(insets.bottom + 20, 32) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Ambient Lighting Background */}
          <View style={styles.ambientTopGlow} />

          {/* Top Brand Header */}
          <View style={styles.brandSection}>
            <View style={styles.logoBadge}>
              <Image
                source={require("../assets/pravaah_navbar_logo.png")}
                style={styles.brandLogo}
                resizeMode="contain"
                accessibilityLabel="Pravaah"
              />
            </View>

            <View style={styles.eyebrowBadge}>
              <View style={styles.pulseDot} />
              <Text style={styles.eyebrowText}>AI SPOKEN ENGLISH COACH</Text>
            </View>

            <Text style={styles.headline}>
              <Text style={styles.headlineItalic}>Own</Text> your voice.
            </Text>
            <Text style={styles.subheadline}>
              Real-time voice coaching, instant Hindi recasts, and natural conversational fluency.
            </Text>
          </View>

          {/* Form Container Card */}
          <View style={styles.formCard}>
            {showForgotPassword ? (
              <>
                <Pressable style={styles.backToSignInRow} onPress={closeForgotPassword} hitSlop={8}>
                  <Ionicons name="arrow-back" size={16} color={theme.colors.ash} />
                  <Text style={styles.backToSignInText}>Back to sign in</Text>
                </Pressable>

                <Text style={styles.forgotPasswordTitle}>Reset your password</Text>

                {resetSent ? (
                  <View style={styles.resetSentBox}>
                    <Ionicons name="mail-open-outline" size={22} color={theme.colors.emeraldSuccess} />
                    <Text style={styles.resetSentText}>
                      If an account exists for {resetEmail.trim()}, a reset link is on its way.
                      Check your inbox (and spam folder).
                    </Text>
                  </View>
                ) : (
                  <>
                    <Text style={styles.forgotPasswordSubtext}>
                      Enter the email address on your account and we'll send a link to reset your
                      password.
                    </Text>

                    <View style={styles.inputGroup}>
                      <Text style={styles.inputLabel}>EMAIL ADDRESS</Text>
                      <View style={styles.inputWrapper}>
                        <Ionicons name="mail-outline" size={18} color={theme.colors.fog} style={styles.inputIcon} />
                        <TextInput
                          style={styles.textInput}
                          placeholder="name@domain.com"
                          placeholderTextColor={theme.colors.steel}
                          keyboardType="email-address"
                          autoCapitalize="none"
                          autoCorrect={false}
                          value={resetEmail}
                          onChangeText={setResetEmail}
                          autoFocus
                        />
                      </View>
                    </View>

                    {resetError ? (
                      <View style={styles.errorBanner}>
                        <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
                        <Text style={styles.errorText}>{resetError}</Text>
                      </View>
                    ) : null}

                    <Pressable
                      style={({ pressed }) => [
                        styles.primarySubmitBtn,
                        pressed && styles.buttonPressed,
                        resetLoading && styles.buttonDisabled,
                      ]}
                      onPress={handleSendResetEmail}
                      disabled={resetLoading}
                    >
                      {resetLoading ? (
                        <ActivityIndicator color={theme.colors.void} size="small" />
                      ) : (
                        <View style={styles.primaryBtnContent}>
                          <Text style={styles.primaryBtnText}>Send Reset Link</Text>
                          <Ionicons name="arrow-forward" size={18} color={theme.colors.void} />
                        </View>
                      )}
                    </Pressable>
                  </>
                )}
              </>
            ) : (
              <>
            {/* Segmented Tab Pill: Sign In / Sign Up */}
            <View style={styles.segmentedContainer}>
              <Pressable
                style={[styles.segmentBtn, !isSignUp && styles.segmentBtnActive]}
                onPress={() => {
                  setIsSignUp(false);
                  setError("");
                }}
              >
                <Text style={[styles.segmentText, !isSignUp && styles.segmentTextActive]}>
                  Sign In
                </Text>
              </Pressable>

              <Pressable
                style={[styles.segmentBtn, isSignUp && styles.segmentBtnActive]}
                onPress={() => {
                  setIsSignUp(true);
                  setError("");
                }}
              >
                <Text style={[styles.segmentText, isSignUp && styles.segmentTextActive]}>
                  Create Account
                </Text>
              </Pressable>
            </View>

            {/* Google Sign-In Button */}
            <Pressable
              style={({ pressed }) => [
                styles.googleButton,
                pressed && styles.buttonPressed,
                googleLoading && styles.buttonDisabled,
              ]}
              onPress={handleGoogleSignIn}
              disabled={googleLoading || loading}
            >
              {googleLoading ? (
                <ActivityIndicator color={theme.colors.pure} size="small" />
              ) : (
                <View style={styles.googleContentRow}>
                  <View style={styles.googleIconBadge}>
                    <Text style={styles.googleIconLetter}>G</Text>
                  </View>
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </View>
              )}
            </Pressable>

            {/* Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with email</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Name Field (sign-up only) */}
            {isSignUp ? (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>YOUR NAME</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="person-outline" size={18} color={theme.colors.fog} style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="How should your coach address you?"
                    placeholderTextColor={theme.colors.steel}
                    autoCapitalize="words"
                    autoCorrect={false}
                    textContentType="name"
                    value={fullName}
                    onChangeText={setFullName}
                  />
                </View>
              </View>
            ) : null}

            {/* Email Field */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>EMAIL ADDRESS</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={18} color={theme.colors.fog} style={styles.inputIcon} />
                <TextInput
                  style={styles.textInput}
                  placeholder="name@domain.com"
                  placeholderTextColor={theme.colors.steel}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={email}
                  onChangeText={setEmail}
                />
              </View>
            </View>

            {/* Password Field */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>PASSWORD</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color={theme.colors.fog} style={styles.inputIcon} />
                <TextInput
                  style={[styles.textInput, { paddingRight: 40 }]}
                  placeholder="••••••••"
                  placeholderTextColor={theme.colors.steel}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  value={password}
                  onChangeText={setPassword}
                />
                <Pressable
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword(!showPassword)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={18}
                    color={theme.colors.fog}
                  />
                </Pressable>
              </View>
            </View>

            {!isSignUp ? (
              <Pressable
                style={styles.forgotPasswordLink}
                onPress={openForgotPassword}
                hitSlop={8}
              >
                <Text style={styles.forgotPasswordLinkText}>Forgot password?</Text>
              </Pressable>
            ) : null}

            {/* Error Banner */}
            {error ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Primary Action Button */}
            <Pressable
              style={({ pressed }) => [
                styles.primarySubmitBtn,
                pressed && styles.buttonPressed,
                loading && styles.buttonDisabled,
              ]}
              onPress={handleSubmit}
              disabled={loading || googleLoading}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.void} size="small" />
              ) : (
                <View style={styles.primaryBtnContent}>
                  <Text style={styles.primaryBtnText}>
                    {isSignUp ? "Get Started Free" : "Sign In to Pravaah"}
                  </Text>
                  <Ionicons name="arrow-forward" size={18} color={theme.colors.void} />
                </View>
              )}
            </Pressable>
              </>
            )}
          </View>

          {/* Privacy & Terms Note */}
          <Text style={styles.footerNote}>
            By continuing, you agree to Pravaah's terms of spoken learning & voice privacy.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  keyboardContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    maxWidth: theme.mobile.maxContentWidth,
    width: "100%",
    alignSelf: "center",
  },
  ambientTopGlow: {
    position: "absolute",
    top: 0,
    alignSelf: "center",
    width: 320,
    height: 240,
    borderRadius: 160,
    backgroundColor: "rgba(132, 125, 255, 0.07)",
    pointerEvents: "none",
  },
  brandSection: {
    alignItems: "center",
    marginBottom: theme.spacing.xl,
  },
  logoBadge: {
    marginBottom: theme.spacing.md,
  },
  brandLogo: {
    width: 150,
    height: 42,
  },
  eyebrowBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(132, 125, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.22)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: theme.spacing.sm,
    gap: 6,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.emeraldSuccess,
  },
  eyebrowText: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.micro,
    color: theme.colors.paleIris,
    letterSpacing: 1.2,
    fontWeight: "600",
  },
  headline: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingLg,
    color: theme.colors.cloud,
    textAlign: "center",
    marginTop: 2,
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  headlineItalic: {
    fontStyle: "italic",
    color: theme.colors.irisGleam,
  },
  subheadline: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: theme.spacing.md,
  },
  formCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    ...theme.shadows.card,
  },
  segmentedContainer: {
    flexDirection: "row",
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    padding: 3,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radii.sm - 2,
  },
  segmentBtnActive: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  segmentText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "500",
    color: theme.colors.fog,
  },
  segmentTextActive: {
    color: theme.colors.pure,
    fontWeight: "600",
  },
  googleButton: {
    height: 48,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  googleContentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  googleIconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.pure,
    alignItems: "center",
    justifyContent: "center",
  },
  googleIconLetter: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    fontWeight: "700",
    color: "#4285f4",
  },
  googleButtonText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "500",
    color: theme.colors.cloud,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: theme.spacing.lg,
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.borderMuted,
  },
  dividerText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.fog,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  inputGroup: {
    marginBottom: theme.spacing.md,
  },
  inputLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.ash,
    letterSpacing: 0.8,
    marginBottom: 6,
    fontWeight: "500",
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    height: 48,
    paddingHorizontal: 12,
  },
  inputIcon: {
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    color: theme.colors.pure,
    height: "100%",
  },
  eyeBtn: {
    position: "absolute",
    right: 12,
    padding: 4,
  },
  forgotPasswordLink: {
    alignSelf: "flex-end",
    paddingVertical: 4,
    marginBottom: theme.spacing.md,
  },
  forgotPasswordLinkText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.paleIris,
    fontWeight: "600",
  },
  backToSignInRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: theme.spacing.lg,
  },
  backToSignInText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
  },
  forgotPasswordTitle: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingSm,
    color: theme.colors.pure,
    marginBottom: 8,
  },
  forgotPasswordSubtext: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  resetSentBox: {
    alignItems: "center",
    gap: 12,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.md,
  },
  resetSentText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.cloud,
    textAlign: "center",
    lineHeight: 20,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 82, 82, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
    borderRadius: theme.radii.sm,
    padding: 10,
    gap: 8,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.crimsonError,
  },
  primarySubmitBtn: {
    height: 50,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.pure,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.sm,
  },
  primaryBtnContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "600",
    color: theme.colors.void,
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  footerNote: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.micro + 1,
    color: theme.colors.steel,
    textAlign: "center",
    marginTop: theme.spacing.lg,
    lineHeight: 16,
    paddingHorizontal: theme.spacing.md,
  },
});
