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
import { theme, useTheme } from "../lib/theme";

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark, toggleTheme, theme: activeTheme } = useTheme();
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
    <View style={[styles.screen, { backgroundColor: colors.canvas }]}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: Math.max(insets.top + 16, 28), paddingBottom: Math.max(insets.bottom + 24, 36) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Top Bar: Brand + Theme Toggle */}
          <View style={styles.topUtilityRow}>
            <Image
              source={
                isDark
                  ? require("../assets/pravaah_navbar_logo.png")
                  : require("../assets/pravaah_navbar_logo_dark.png")
              }
              style={styles.brandLogo}
              resizeMode="contain"
              accessibilityLabel="Pravaah"
            />

            <Pressable
              style={({ pressed }) => [
                styles.themeToggleBtn,
                { borderColor: colors.border },
                pressed && styles.buttonPressed,
              ]}
              onPress={toggleTheme}
              accessibilityRole="button"
              accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          {/* Hero Section */}
          <View style={styles.brandSection}>
            <Text style={[styles.eyebrowText, { color: colors.irisBlue }]}>AI spoken English coach</Text>
            <Text style={[styles.headline, { color: colors.textPrimary }]}>
              Speak English with confidence
            </Text>
            <Text style={[styles.subheadline, { color: colors.textSecondary }]}>
              Short daily voice conversations with instant corrections and Hindi explanations when you need them.
            </Text>
          </View>

          {/* Form Container Card */}
          <View
            style={[
              styles.formCard,
              {
                backgroundColor: colors.cardElevated,
                borderColor: colors.border,
              },
              activeTheme.shadows.sm,
            ]}
          >
            {showForgotPassword ? (
              <>
                <Pressable style={styles.backToSignInRow} onPress={closeForgotPassword} hitSlop={8}>
                  <Ionicons name="arrow-back" size={18} color={colors.irisBlue} />
                  <Text style={[styles.backToSignInText, { color: colors.irisBlue }]}>
                    Back to sign in
                  </Text>
                </Pressable>

                <Text style={[styles.forgotPasswordTitle, { color: colors.textPrimary }]}>
                  Reset your password
                </Text>

                {resetSent ? (
                  <View
                    style={[
                      styles.resetSentBox,
                      { backgroundColor: colors.mintWash, borderColor: colors.mintBorder },
                    ]}
                  >
                    <Ionicons name="mail-open-outline" size={26} color={colors.emeraldSuccess} />
                    <Text style={[styles.resetSentText, { color: colors.textPrimary }]}>
                      If an account exists for {resetEmail.trim()}, a reset link is on its way.
                      Check your inbox (and spam folder).
                    </Text>
                  </View>
                ) : (
                  <>
                    <Text style={[styles.forgotPasswordSubtext, { color: colors.textSecondary }]}>
                      Enter the email address on your account and we'll send a link to reset your
                      password.
                    </Text>

                    <View style={styles.inputGroup}>
                      <Text style={[styles.inputLabel, { color: colors.textPrimary }]}>Email</Text>
                      <View
                        style={[
                          styles.inputWrapper,
                          {
                            backgroundColor: colors.cardElevated,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <Ionicons name="mail-outline" size={18} color={colors.fog} style={styles.inputIcon} />
                        <TextInput
                          style={[styles.textInput, { color: colors.textPrimary }]}
                          placeholder="name@domain.com"
                          placeholderTextColor={colors.fog}
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
                      <View
                        style={[
                          styles.errorBanner,
                          { backgroundColor: colors.crimsonWash, borderColor: colors.crimsonError },
                        ]}
                      >
                        <Ionicons name="alert-circle" size={18} color={colors.crimsonError} />
                        <Text style={[styles.errorText, { color: colors.crimsonError }]}>{resetError}</Text>
                      </View>
                    ) : null}

                    <Pressable
                      style={({ pressed }) => [
                        styles.primarySubmitBtn,
                        { backgroundColor: colors.primary },
                        pressed && styles.buttonPressed,
                        resetLoading && styles.buttonDisabled,
                      ]}
                      onPress={handleSendResetEmail}
                      disabled={resetLoading}
                    >
                      {resetLoading ? (
                        <ActivityIndicator color={colors.textOnPrimary} size="small" />
                      ) : (
                        <Text style={[styles.primaryBtnText, { color: colors.textOnPrimary }]}>
                          Send reset link
                        </Text>
                      )}
                    </Pressable>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Segmented Tab Pill: Sign In / Sign Up */}
                <View
                  style={[
                    styles.segmentedContainer,
                    { backgroundColor: colors.cardSubtle, borderColor: colors.border },
                  ]}
                >
                  <Pressable
                    style={[
                      styles.segmentBtn,
                      !isSignUp && [
                        styles.segmentBtnActive,
                        { backgroundColor: colors.cardElevated },
                        activeTheme.shadows.sm,
                      ],
                    ]}
                    onPress={() => {
                      setIsSignUp(false);
                      setError("");
                    }}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        { color: colors.textSecondary },
                        !isSignUp && [styles.segmentTextActive, { color: colors.textPrimary }],
                      ]}
                    >
                      Sign in
                    </Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.segmentBtn,
                      isSignUp && [
                        styles.segmentBtnActive,
                        { backgroundColor: colors.cardElevated },
                        activeTheme.shadows.sm,
                      ],
                    ]}
                    onPress={() => {
                      setIsSignUp(true);
                      setError("");
                    }}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        { color: colors.textSecondary },
                        isSignUp && [styles.segmentTextActive, { color: colors.textPrimary }],
                      ]}
                    >
                      Create account
                    </Text>
                  </Pressable>
                </View>

                {/* Google Sign-In Button */}
                <Pressable
                  style={({ pressed }) => [
                    styles.googleButton,
                    {
                      backgroundColor: colors.cardElevated,
                      borderColor: colors.border,
                    },
                    pressed && styles.buttonPressed,
                    googleLoading && styles.buttonDisabled,
                  ]}
                  onPress={handleGoogleSignIn}
                  disabled={googleLoading || loading}
                >
                  {googleLoading ? (
                    <ActivityIndicator color={colors.irisBlue} size="small" />
                  ) : (
                    <View style={styles.googleContentRow}>
                      <Ionicons name="logo-google" size={18} color={colors.textPrimary} />
                      <Text style={[styles.googleButtonText, { color: colors.textPrimary }]}>
                        Continue with Google
                      </Text>
                    </View>
                  )}
                </Pressable>

                {/* Divider */}
                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.dividerText, { color: colors.textMuted }]}>
                    or
                  </Text>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                </View>

                {/* Name Field (sign-up only) */}
                {isSignUp ? (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: colors.textPrimary }]}>Name</Text>
                    <View
                      style={[
                        styles.inputWrapper,
                        { backgroundColor: colors.cardElevated, borderColor: colors.border },
                      ]}
                    >
                      <Ionicons name="person-outline" size={18} color={colors.fog} style={styles.inputIcon} />
                      <TextInput
                        style={[styles.textInput, { color: colors.textPrimary }]}
                        placeholder="How should your coach address you?"
                        placeholderTextColor={colors.fog}
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
                  <Text style={[styles.inputLabel, { color: colors.textPrimary }]}>Email</Text>
                  <View
                    style={[
                      styles.inputWrapper,
                      { backgroundColor: colors.cardElevated, borderColor: colors.border },
                    ]}
                  >
                    <Ionicons name="mail-outline" size={18} color={colors.fog} style={styles.inputIcon} />
                    <TextInput
                      style={[styles.textInput, { color: colors.textPrimary }]}
                      placeholder="name@domain.com"
                      placeholderTextColor={colors.fog}
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
                  <Text style={[styles.inputLabel, { color: colors.textPrimary }]}>Password</Text>
                  <View
                    style={[
                      styles.inputWrapper,
                      { backgroundColor: colors.cardElevated, borderColor: colors.border },
                    ]}
                  >
                    <Ionicons name="lock-closed-outline" size={18} color={colors.fog} style={styles.inputIcon} />
                    <TextInput
                      style={[styles.textInput, { paddingRight: 40, color: colors.textPrimary }]}
                      placeholder="••••••••"
                      placeholderTextColor={colors.fog}
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
                        color={colors.fog}
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
                    <Text style={[styles.forgotPasswordLinkText, { color: colors.irisBlue }]}>
                      Forgot password?
                    </Text>
                  </Pressable>
                ) : null}

                {/* Error Banner */}
                {error ? (
                  <View
                    style={[
                      styles.errorBanner,
                      { backgroundColor: colors.crimsonWash, borderColor: colors.crimsonError },
                    ]}
                  >
                    <Ionicons name="alert-circle" size={18} color={colors.crimsonError} />
                    <Text style={[styles.errorText, { color: colors.crimsonError }]}>{error}</Text>
                  </View>
                ) : null}

                {/* Primary Action Button */}
                <Pressable
                  style={({ pressed }) => [
                    styles.primarySubmitBtn,
                    { backgroundColor: colors.primary },
                    pressed && styles.buttonPressed,
                    loading && styles.buttonDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={loading || googleLoading}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.textOnPrimary} size="small" />
                  ) : (
                    <Text style={[styles.primaryBtnText, { color: colors.textOnPrimary }]}>
                      {isSignUp ? "Create account" : "Sign in"}
                    </Text>
                  )}
                </Pressable>
              </>
            )}
          </View>

          {/* Privacy & Terms Note */}
          <Text style={[styles.footerNote, { color: colors.textMuted }]}>
            By continuing, you agree to Pravaah's terms and privacy policy.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  keyboardContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  topUtilityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing.lg,
    gap: 8,
  },
  themeToggleBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  brandSection: {
    marginBottom: 28,
  },
  brandLogo: {
    width: 112,
    height: 40,
  },
  eyebrowText: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 8,
  },
  headline: {
    fontFamily: theme.fonts.display,
    fontSize: 30,
    fontWeight: "600",
    marginBottom: 10,
    letterSpacing: -0.6,
    lineHeight: 36,
  },
  subheadline: {
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  formCard: {
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
  },
  segmentedContainer: {
    flexDirection: "row",
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
    borderWidth: 1,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  segmentBtnActive: {},
  segmentText: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    fontWeight: "500",
  },
  segmentTextActive: {
    fontWeight: "600",
  },
  googleButton: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  googleContentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  googleButtonText: {
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    fontWeight: "500",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 20,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    marginBottom: 6,
    fontWeight: "500",
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    paddingHorizontal: 14,
  },
  inputIcon: {
    marginRight: 10,
  },
  textInput: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
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
    fontWeight: "600",
  },
  forgotPasswordTitle: {
    fontFamily: theme.fonts.display,
    fontSize: theme.fontSizes.headingSm,
    fontWeight: "600",
    marginBottom: 8,
  },
  forgotPasswordSubtext: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  resetSentBox: {
    alignItems: "center",
    gap: 12,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.md,
    borderRadius: 14,
    borderWidth: 1,
  },
  resetSentText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    textAlign: "center",
    lineHeight: 20,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "500",
  },
  primarySubmitBtn: {
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  primaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    fontWeight: "600",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  footerNote: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    textAlign: "center",
    marginTop: theme.spacing.lg,
    lineHeight: 18,
    paddingHorizontal: theme.spacing.md,
  },
});
