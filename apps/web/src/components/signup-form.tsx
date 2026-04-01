import { useForm } from "@tanstack/react-form";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { getFirstErrorMessage } from "@/lib/form-errors";
import { cn } from "@/lib/utils";

const signupFormSchema = z
  .object({
    name: z.string().min(1, "Full name is required."),
    email: z.email("Please enter a valid email address."),
    password: z.string().min(8, "Password must be at least 8 characters long."),
    confirmPassword: z.string().min(8, "Confirm password must be at least 8 characters long."),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export function SignupForm({
  redirectTo,
  className,
  ...props
}: React.ComponentProps<"div"> & { redirectTo?: string }) {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const form = useForm({
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
    validators: {
      onChange: signupFormSchema,
    },
    onSubmit: async ({ value }) => {
      setErrorMessage(null);

      setIsPending(true);
      const { error } = await authClient.signUp.email({
        name: value.name,
        email: value.email,
        password: value.password,
      });
      setIsPending(false);

      if (error) {
        // TODO: Map Better Auth server validation details to field-level messages.
        setErrorMessage("Could not create your account. Please check your input and try again.");
        return;
      }

      await navigate({ to: redirectTo || "/mail" });
    },
  });

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Create an account</CardTitle>
          <CardDescription>Fill in the form to create your Kirimail account</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="name">
                {(field) => {
                  const inlineError = field.state.meta.isTouched
                    ? getFirstErrorMessage(field.state.meta.errors)
                    : null;

                  return (
                    <Field>
                      <FieldLabel htmlFor="name">Full Name</FieldLabel>
                      <Input
                        id="name"
                        name="name"
                        type="text"
                        placeholder="John Doe"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      {inlineError ? (
                        <FieldDescription className="text-destructive">
                          {inlineError}
                        </FieldDescription>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="email">
                {(field) => {
                  const inlineError = field.state.meta.isTouched
                    ? getFirstErrorMessage(field.state.meta.errors)
                    : null;

                  return (
                    <Field>
                      <FieldLabel htmlFor="email">Email</FieldLabel>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        placeholder="mail@example.com"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      {inlineError ? (
                        <FieldDescription className="text-destructive">
                          {inlineError}
                        </FieldDescription>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <Field>
                <Field className="grid grid-cols-2 gap-4">
                  <form.Field name="password">
                    {(field) => {
                      const inlineError = field.state.meta.isTouched
                        ? getFirstErrorMessage(field.state.meta.errors)
                        : null;

                      return (
                        <Field>
                          <FieldLabel htmlFor="password">Password</FieldLabel>
                          <Input
                            id="password"
                            name="password"
                            type="password"
                            required
                            minLength={8}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          {inlineError ? (
                            <FieldDescription className="text-destructive">
                              {inlineError}
                            </FieldDescription>
                          ) : null}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="confirmPassword">
                    {(field) => {
                      const inlineError = field.state.meta.isTouched
                        ? getFirstErrorMessage(field.state.meta.errors)
                        : null;

                      return (
                        <Field>
                          <FieldLabel htmlFor="confirm-password">Confirm Password</FieldLabel>
                          <Input
                            id="confirm-password"
                            name="confirm-password"
                            type="password"
                            required
                            minLength={8}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          {inlineError ? (
                            <FieldDescription className="text-destructive">
                              {inlineError}
                            </FieldDescription>
                          ) : null}
                        </Field>
                      );
                    }}
                  </form.Field>
                </Field>
              </Field>
              {errorMessage ? (
                <FieldDescription className="text-destructive">{errorMessage}</FieldDescription>
              ) : null}
              <Field>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Signing up..." : "Sign Up"}
                </Button>
                <FieldDescription className="text-center">
                  Already have an account?{" "}
                  <Link to="/sign-in" search={redirectTo ? { redirect: redirectTo } : undefined}>
                    Sign in
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        {/* TODO: Configure ToS and Privacy Policy and change this */}
        By creating account, you agree to our <a href="#">Terms of Service</a> and{" "}
        <a href="#">Privacy Policy</a>.
      </FieldDescription>
    </div>
  );
}
