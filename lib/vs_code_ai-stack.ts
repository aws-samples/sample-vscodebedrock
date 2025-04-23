import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acmpca from 'aws-cdk-lib/aws-acmpca';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as rolesanywhere from 'aws-cdk-lib/aws-rolesanywhere';
import { Construct } from 'constructs';

export class VsCodeAiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      env: {
        region: 'us-gov-west-1'  // Explicitly set GovCloud region
      }
    });

    // Create a root Certificate Authority
    const rootCA = new acmpca.CfnCertificateAuthority(this, 'RootCA', {
      type: 'ROOT',
      keyAlgorithm: 'RSA_2048',
      signingAlgorithm: 'SHA256WITHRSA',
      subject: {
        country: 'US',
        organization: 'Your Organization',
        organizationalUnit: 'Your Org Unit',
        state: 'Your State',
        commonName: 'your-domain.com',
        locality: 'Your City'
      },
      csrExtensions: {
        keyUsage: {
          keyCertSign: true,
          crlSign: true
        }
      }
    });

    // Add the root certificate
    const rootCACert = new acmpca.CfnCertificate(this, 'RootCACert', {
      certificateAuthorityArn: rootCA.attrArn,
      certificateSigningRequest: rootCA.attrCertificateSigningRequest,
      signingAlgorithm: 'SHA256WITHRSA',
      templateArn: `arn:${cdk.Stack.of(this).partition}:acm-pca:::template/RootCACertificate/V1`,
      validity: {
        type: 'YEARS',
        value: 2 //adjust the number of years you want root CA to be valid
      }
    });
    rootCACert.node.addDependency(rootCA);

    // Import the certificate back to the CA
    const rootCAActivation = new acmpca.CfnCertificateAuthorityActivation(this, 'RootCAActivation', {
      certificateAuthorityArn: rootCA.attrArn,
      certificate: rootCACert.attrCertificate
    });
    rootCAActivation.node.addDependency(rootCACert)


    // Create a client certificate in ACM issued by the Private CA
    const clientCert = new acm.PrivateCertificate(this, 'ClientCert', {
      certificateAuthority: acmpca.CertificateAuthority.fromCertificateAuthorityArn(
        this, 
        'ImportedCA', 
        rootCA.attrArn
      ),
      domainName: 'your-domain.com', // Replace with your domain
      subjectAlternativeNames: ['alt.your-domain.com'], // Optional: add if needed
      keyAlgorithm: acm.KeyAlgorithm.RSA_2048, // Optional: defaults to RSA_2048
    });
    clientCert.node.addDependency(rootCA);
    clientCert.node.addDependency(rootCAActivation);
    clientCert.node.addDependency(rootCACert);

    

    // Create the trust policy for IAM Roles Anywhere
    const trustPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [
            new iam.ServicePrincipal('rolesanywhere.amazonaws.com')
          ],
          actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
          conditions: {
            StringEquals: {
              '`${cdk.Stack.of(this).partition}:PrincipalTag/x-aws-rolesanywhere:session-policy-mode`': 'default'
            }
          }
        })
      ]
    });

    // Create the customer managed policy
    const bedrockPolicy = new iam.Policy(this, 'BedrockAccessPolicy', {
      policyName: 'bedrock-access-policy',
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:ListFoundationModels',
              'bedrock:GetFoundationModel'
            ],
            resources: [
              `arn:${cdk.Stack.of(this).partition}:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
              `arn:${cdk.Stack.of(this).partition}:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:foundation-model/amazon.titan-text-express-v1`
            ]
          })
        ]
      })
    });

    // Create the role and attach the customer managed policy
    const bedrockRole = new iam.Role(this, 'BedrockRoleAnywhere', {
      roleName: 'bedrock-role-anywhere',
      assumedBy: new iam.ServicePrincipal('rolesanywhere.amazonaws.com'),
      description: 'Role for accessing Bedrock via IAM Roles Anywhere in GovCloud'
    });

    // Attach the policy to the role
    bedrockRole.attachInlinePolicy(bedrockPolicy);

    // Create a trust anchor for IAM Roles Anywhere
    const trustAnchor = new rolesanywhere.CfnTrustAnchor(this, 'BedrockTrustAnchor', {
      name: 'bedrock-trust-anchor',
      source: {
        sourceData: {
          acmPcaArn: rootCA.attrArn
        },
        sourceType: 'AWS_ACM_PCA'
      },
      enabled: true
    });
    trustAnchor.node.addDependency(rootCAActivation);

    // Create a profile for IAM Roles Anywhere
    const profile = new rolesanywhere.CfnProfile(this, 'BedrockProfile', {
      name: 'bedrock-profile',
      roleArns: [bedrockRole.roleArn],
      enabled: true,
      durationSeconds: 3600, // 1 hour session duration
    });

    // Optional: Add tags to the resources
    cdk.Tags.of(bedrockRole).add('Purpose', 'BedrockAccess');
    cdk.Tags.of(bedrockRole).add('Environment', 'GovCloud');
    cdk.Tags.of(rootCA).add('Purpose', 'RolesAnywhere');
    cdk.Tags.of(rootCA).add('Environment', 'GovCloud');
    cdk.Tags.of(trustAnchor).add('Purpose', 'RolesAnywhere');
    cdk.Tags.of(profile).add('Purpose', 'RolesAnywhere');

    // Outputs
    new cdk.CfnOutput(this, 'BedrockRoleArnOutput', {
      value: bedrockRole.roleArn,
      description: 'ARN of the IAM role for Bedrock access in GovCloud',
      exportName: 'BedrockRoleArn'
    });

    new cdk.CfnOutput(this, 'CertificateAuthorityArnOutput', {
      value: rootCA.attrArn,
      description: 'ARN of the Root Certificate Authority',
      exportName: 'RootCAArn'
    });

    new cdk.CfnOutput(this, 'TrustAnchorArnOutput', {
      value: trustAnchor.attrTrustAnchorArn,
      description: 'ARN of the IAM Roles Anywhere Trust Anchor',
      exportName: 'TrustAnchorArn'
    });

    new cdk.CfnOutput(this, 'ProfileArnOutput', {
      value: profile.attrProfileArn,
      description: 'ARN of the IAM Roles Anywhere Profile',
      exportName: 'ProfileArn'
    });
  }
}
